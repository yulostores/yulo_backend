// CB3 — seller signup and onboarding: the signup proof, each onboarding section with its
// validation, PAN/Aadhaar never stored or returned in clear, the team list, documents, submit,
// status, and what an approved seller can no longer change. In-memory MongoDB, in-memory Redis
// stand-in, Cloudinary mocked.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const fx = await import('../test-utils/sellerFixtures.mjs');
const { VALID, businessBody, ownerBody, makeCategory, makeCompleteSeller, sellerHeaders, mockCloudinary, uploadFile, yearsAgo } = fx;
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const { sellerAuthLimiter, sellerAuthLimiterKey } = await import('../middleware/rateLimiter.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let category;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Seller.init(), SellerUser.init(), CouponCategory.init()]);
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await sellerAuthLimiter.resetKey(sellerAuthLimiterKey(ip));
  category = await makeCategory({ key: 'salon', name: 'Salon' });
});

const PHONE = '9876543210';
const call = (method, path, body, headers = {}) => srv.request(method, `/api/seller${path}`, { body, headers });
const onboarding = (headers) => srv.get('/api/seller/onboarding', headers);

// A brand-new owner, signed up through the real OTP → signup flow. Returns { headers, seller, owner }.
const signUp = async (phone = PHONE) => {
  const code = (await call('POST', '/auth/otp/send', { phone })).body.data.devOtp;
  const verified = await call('POST', '/auth/otp/verify', { phone, code });
  assert.equal(verified.body.data.needsSignup, true);
  const res = await call('POST', '/auth/signup', {
    signupToken: verified.body.data.signupToken,
    businessName: 'Glow Salon',
    categoryId: String(category._id),
    ownerName: 'Asha Rao',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const seller = await Seller.findById(res.body.data.seller._id);
  const owner = await SellerUser.findOne({ sellerId: seller._id, role: 'owner' });
  return { headers: { authorization: `Bearer ${res.body.data.accessToken}` }, seller, owner, res };
};

// Everything that could contain an identity number in clear.
const assertNoClearIdentity = (value, label) => {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(VALID.pan), `${label}: full PAN present`);
  assert.ok(!text.includes(VALID.aadhaar), `${label}: full Aadhaar present`);
};

// ── Signup ────────────────────────────────────────────────────────────────────

test('signup creates a pending seller and its owner login, and signs the owner in', async () => {
  const { seller, owner, res, headers } = await signUp();
  assert.equal(seller.status, 'pending');
  assert.equal(seller.businessName, 'Glow Salon');
  assert.equal(String(seller.categoryId), String(category._id));
  assert.equal(seller.owner.phone, PHONE);
  assert.equal(owner.role, 'owner');
  assert.equal(owner.isActive, true);
  assert.deepEqual(res.body.data.permissions.includes('onboarding.edit'), true);
  assert.match(res.headers.get('set-cookie'), /yulo_rt_seller=/);
  assert.equal((await srv.get('/api/seller/auth/me', headers)).status, 200);
});

test('the signup proof works once', async () => {
  const code = (await call('POST', '/auth/otp/send', { phone: PHONE })).body.data.devOtp;
  const { signupToken } = (await call('POST', '/auth/otp/verify', { phone: PHONE, code })).body.data;
  const body = { signupToken, businessName: 'Glow Salon', categoryId: String(category._id), ownerName: 'Asha Rao' };
  assert.equal((await call('POST', '/auth/signup', body)).status, 201);
  assert.equal((await call('POST', '/auth/signup', { ...body, businessName: 'Second Shop' })).status, 401);
  assert.equal(await Seller.countDocuments(), 1);
});

test('a number that already owns a business cannot sign up another', async () => {
  await makeCompleteSeller({ phone: PHONE, categoryId: category._id });
  const signupToken = auth.generateSellerProofToken('signup', PHONE);
  const res = await call('POST', '/auth/signup', { signupToken, businessName: 'Another', categoryId: String(category._id), ownerName: 'Asha' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PHONE_ALREADY_REGISTERED');
  assert.equal(await Seller.countDocuments(), 1);
});

test('signup refuses a bad proof, an unknown category and bad input', async () => {
  const good = { businessName: 'Glow Salon', categoryId: String(category._id), ownerName: 'Asha Rao' };
  const owner = (await makeCompleteSeller({ phone: '9000000002', categoryId: category._id })).owner;
  assert.equal((await call('POST', '/auth/signup', { ...good, signupToken: 'garbage' })).status, 401);
  // A session token is not a signup proof.
  const access = auth.generateSellerTokens(owner).accessToken;
  assert.equal((await call('POST', '/auth/signup', { ...good, signupToken: access })).status, 401);

  const signupToken = auth.generateSellerProofToken('signup', PHONE);
  const unknown = await call('POST', '/auth/signup', { ...good, signupToken, categoryId: String(new mongoose.Types.ObjectId()) });
  assert.equal(unknown.status, 400);
  for (const bad of [{ businessName: 'x' }, { ownerName: '' }, { categoryId: 'nope' }, { extra: 1 }]) {
    const res = await call('POST', '/auth/signup', { ...good, signupToken, ...bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('the signup category list is public and lists disabled categories too', async () => {
  await makeCategory({ key: 'spa', name: 'Spa', enabled: true, sortOrder: -1 });
  const res = await srv.get('/api/seller/auth/categories');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.categories.map((c) => c.name), ['Spa', 'Salon']);
});

// ── Who may use onboarding ────────────────────────────────────────────────────

test('onboarding is the owner\'s: managers and employees, other tokens and no token are refused', async () => {
  const { seller } = await signUp();
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  for (const role of ['manager', 'employee']) {
    const u = await SellerUser.create({ sellerId: seller._id, name: role, phone: role === 'manager' ? '9111111111' : '9222222222', role });
    assert.equal((await onboarding(sellerHeaders(u))).status, 403, role);
  }
  assert.equal((await srv.get('/api/seller/onboarding')).status, 401);
  const customerToken = auth.generateTokens(customer._id, 'customer').accessToken;
  assert.equal((await onboarding({ authorization: `Bearer ${customerToken}` })).status, 401);
});

test('an empty onboarding form lists everything that is missing', async () => {
  const { headers } = await signUp();
  const res = await onboarding(headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.editable, true);
  assert.deepEqual(res.body.data.missing, ['business', 'owner', 'document:pan_card', 'document:aadhaar_card']);
});

// ── Business ──────────────────────────────────────────────────────────────────

test('business details: valid save, with the map pin stored as a point', async () => {
  const { headers, seller } = await signUp();
  const res = await call('PUT', '/onboarding/business', businessBody(category._id, { gstNumber: '29abcde1234f1z5' }), headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body.data.business;
  assert.equal(b.gstNumber, VALID.gstin, 'normalised to upper case');
  assert.equal(b.address.pincode, '560001');
  assert.deepEqual(b.location, { lat: 12.97, lng: 77.59 });
  assert.equal(b.category.name, 'Salon');
  const stored = await Seller.findById(seller._id).lean();
  assert.deepEqual(stored.location.coordinates, [77.59, 12.97]);
  // GST given → the certificate becomes required.
  assert.ok(res.body.data.missing.includes('document:gst_certificate'));
});

test('business details: every invalid field is refused', async () => {
  const { headers } = await signUp();
  const cases = {
    gstNumber: { gstNumber: '29ABCDE1234F1X5' },
    categoryId: { categoryId: String(new mongoose.Types.ObjectId()) },
    pincode: { address: { line1: '12 MG Road', city: 'Bengaluru', state: 'KA', pincode: '012345' } },
    phone: { businessPhone: '12345' },
    future: { establishedOn: '2999-01-01' },
    location: { location: { lat: 200, lng: 77 } },
    extra: { website: 'x' },
  };
  for (const [label, over] of Object.entries(cases)) {
    const res = await call('PUT', '/onboarding/business', businessBody(category._id, over), headers);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.code, 'VALIDATION_ERROR', label);
  }
  // GST is optional.
  assert.equal((await call('PUT', '/onboarding/business', businessBody(category._id, { gstNumber: null }), headers)).status, 200);
});

// ── Owner, PAN and Aadhaar ────────────────────────────────────────────────────

test('owner details: PAN and Aadhaar stored only encrypted, neither ever returned', async () => {
  const { headers, seller, owner } = await signUp();
  const res = await call('PUT', '/onboarding/owner', ownerBody({ pan: 'abcde 1234 f', aadhaar: '2341 2341 2346' }), headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.owner.panMasked, '******234F');
  assert.equal(res.body.data.owner.aadhaarMasked, 'XXXX XXXX 2346');
  assertNoClearIdentity(res.body, 'PUT response');
  assertNoClearIdentity((await onboarding(headers)).body, 'GET response');

  const raw = await mongoose.connection.collection('sellers').findOne({ _id: seller._id });
  assert.match(raw.owner.panEncrypted, /^v1:/);
  assert.match(raw.owner.aadhaarEncrypted, /^v1:/, 'the full Aadhaar is kept, encrypted');
  assert.equal(raw.owner.aadhaarLast4, '2346');
  assertNoClearIdentity(raw, 'database document');

  // The owner's login takes the name.
  assert.equal((await SellerUser.findById(owner._id).lean()).name, 'Asha Rao');
});

test('owner details: an Aadhaar number that fails the Verhoeff check digit is accepted (format only)', async () => {
  const { headers } = await signUp();
  const res = await call('PUT', '/onboarding/owner', ownerBody({ aadhaar: VALID.aadhaarBadChecksum }), headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.owner.aadhaarMasked, 'XXXX XXXX 2345');
});

test('owner details: invalid PAN, Aadhaar format, under-18 and missing numbers are refused', async () => {
  const { headers } = await signUp();
  const cases = {
    pan: { pan: 'ABCD1234FF' },
    aadhaarLength: { aadhaar: '23412341234' },
    aadhaarStartsWith1: { aadhaar: '134123412345' },
    under18: { dateOfBirth: yearsAgo(17) },
    phone: { phone: '5555555555' },
  };
  for (const [label, over] of Object.entries(cases)) {
    const res = await call('PUT', '/onboarding/owner', ownerBody(over), headers);
    assert.equal(res.status, 400, label);
  }
  const { pan, aadhaar, ...withoutNumbers } = ownerBody();
  const first = await call('PUT', '/onboarding/owner', withoutNumbers, headers);
  assert.equal(first.status, 400);
  assert.ok(first.body.details.fieldErrors.pan && first.body.details.fieldErrors.aadhaar);
});

test('owner details: a later save may leave PAN and Aadhaar out and keeps them', async () => {
  const { headers } = await signUp();
  await call('PUT', '/onboarding/owner', ownerBody(), headers);
  const { pan, aadhaar, ...rest } = ownerBody({ name: 'Asha R. Rao' });
  const res = await call('PUT', '/onboarding/owner', rest, headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.owner.name, 'Asha R. Rao');
  assert.equal(res.body.data.owner.panMasked, '******234F');
});

// ── Team ──────────────────────────────────────────────────────────────────────

const employee = (over = {}) => ({ name: 'Ravi', phone: '9333333333', dateOfBirth: yearsAgo(25), gender: 'male', experienceYears: 3, role: 'employee', ...over });

test('the team list creates logins that stay inactive until approval', async () => {
  const { headers, seller } = await signUp();
  const res = await call('PUT', '/onboarding/employees', { employees: [employee(), employee({ name: 'Meera', phone: '9444444444', role: 'manager', gender: 'female' })] }, headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.employees.map((e) => [e.name, e.role, e.isActive]), [['Ravi', 'employee', false], ['Meera', 'manager', false]]);
  assert.equal(await SellerUser.countDocuments({ sellerId: seller._id, isActive: false }), 2);
});

test('the team list: roles, duplicates and the owner\'s own number are refused', async () => {
  const { headers } = await signUp();
  for (const role of ['owner', 'admin', 'waiter']) {
    const res = await call('PUT', '/onboarding/employees', { employees: [employee({ role })] }, headers);
    assert.equal(res.status, 400, role);
  }
  const dup = await call('PUT', '/onboarding/employees', { employees: [employee(), employee({ name: 'Other' })] }, headers);
  assert.equal(dup.status, 400);
  assert.deepEqual(dup.body.details.duplicatePhones, ['9333333333']);
  const ownerNumber = await call('PUT', '/onboarding/employees', { employees: [employee({ phone: PHONE })] }, headers);
  assert.equal(ownerNumber.status, 400);
  const tooYoung = await call('PUT', '/onboarding/employees', { employees: [employee({ dateOfBirth: yearsAgo(10) })] }, headers);
  assert.equal(tooYoung.status, 400);
});

test('saving the team again updates by phone, removes whoever was left out, and signs changed people out', async () => {
  const { headers, seller } = await signUp();
  await call('PUT', '/onboarding/employees', { employees: [employee(), employee({ name: 'Meera', phone: '9444444444' })] }, headers);
  const ravi = await SellerUser.findOne({ sellerId: seller._id, phone: '9333333333' }).lean();

  const res = await call('PUT', '/onboarding/employees', { employees: [employee({ name: 'Ravi K', role: 'manager' })] }, headers);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.employees.map((e) => e.name), ['Ravi K']);
  const raviNow = await SellerUser.findById(ravi._id).lean();
  assert.equal(raviNow.role, 'manager');
  assert.equal(raviNow.sessionVersion, ravi.sessionVersion + 1, 'a role change ends the old session');
  const meera = await SellerUser.findOne({ sellerId: seller._id, phone: '9444444444' }).lean();
  assert.ok(meera.removedAt);
  assert.equal(meera.isActive, false);
});

// ── Documents ─────────────────────────────────────────────────────────────────

test('documents: upload, replace in place, delete; storage URLs never returned', async () => {
  const { headers, seller } = await signUp();
  const cloud = await mockCloudinary();
  try {
    const first = await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'pan_card' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.documents.length, 1);
    assert.equal(first.body.data.documents[0].status, 'pending');
    assert.equal(first.body.data.documents[0].url, undefined);
    assert.match(cloud.uploads[0].folder, new RegExp(`sellers/${seller._id}/documents`));

    const pdf = await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'pan_card', name: 'pan.pdf', mime: 'application/pdf', bytes: '%PDF-1.4' });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.data.documents.length, 1, 'replaced, not appended');
    assert.equal(cloud.uploads[1].resource_type, 'raw', 'PDFs stored raw');
    assert.equal(cloud.destroyed.length, 1, 'the old file is deleted from storage');

    const docId = pdf.body.data.documents[0]._id;
    const del = await call('DELETE', `/onboarding/documents/${docId}`, undefined, headers);
    assert.equal(del.status, 200);
    assert.equal(del.body.data.documents.length, 0);
    assert.equal((await call('DELETE', `/onboarding/documents/${docId}`, undefined, headers)).status, 404);
  } finally {
    cloud.restore();
  }
});

test('documents: unknown type, missing file, wrong file type, verified documents and storage failure', async () => {
  const { headers, seller } = await signUp();
  const cloud = await mockCloudinary();
  try {
    assert.equal((await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'passport' })).status, 400);
    assert.equal((await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, {})).status, 400);
    const exe = await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'pan_card', name: 'x.exe', mime: 'application/x-msdownload' });
    assert.equal(exe.status, 400);

    await Seller.updateOne({ _id: seller._id }, { $push: { documents: { type: 'aadhaar_card', url: 'u', status: 'verified' } } });
    const verified = await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'aadhaar_card' });
    assert.equal(verified.status, 409);
    const docId = (await Seller.findById(seller._id).lean()).documents[0]._id;
    assert.equal((await call('DELETE', `/onboarding/documents/${docId}`, undefined, headers)).status, 409);
  } finally {
    cloud.restore();
  }
  const failing = await mockCloudinary({ failUpload: true });
  try {
    const res = await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'pan_card' });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'UPLOAD_FAILED');
  } finally {
    failing.restore();
  }
});

test('one owner cannot touch another seller\'s documents', async () => {
  const a = await signUp();
  const b = await makeCompleteSeller({ phone: '9000000003', categoryId: category._id });
  const bDoc = b.seller.documents[0]._id;
  assert.equal((await call('DELETE', `/onboarding/documents/${bDoc}`, undefined, a.headers)).status, 404);
  assert.equal((await srv.get(`/api/seller/onboarding/documents/${bDoc}/file`, a.headers)).status, 404);
  // And the form an owner reads is always their own.
  assert.equal((await onboarding(a.headers)).body.data.business.businessName, 'Glow Salon');
  assert.equal(String((await Seller.findById(b.seller._id).lean()).documents.length), '2');
});

// ── Submit & status ───────────────────────────────────────────────────────────

test('submit refuses an incomplete application with the list of what is missing', async () => {
  const { headers } = await signUp();
  await call('PUT', '/onboarding/business', businessBody(category._id), headers);
  const res = await call('POST', '/onboarding/submit', undefined, headers);
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'ONBOARDING_INCOMPLETE');
  assert.deepEqual(res.body.details.missing, ['owner', 'document:pan_card', 'document:aadhaar_card', 'document:gst_certificate']);
});

test('a complete application is submitted through the real endpoints', async () => {
  const { headers, seller } = await signUp();
  const cloud = await mockCloudinary();
  try {
    assert.equal((await call('PUT', '/onboarding/business', businessBody(category._id, { gstNumber: null }), headers)).status, 200);
    assert.equal((await call('PUT', '/onboarding/owner', ownerBody(), headers)).status, 200);
    assert.equal((await call('PUT', '/onboarding/employees', { employees: [employee()] }, headers)).status, 200);
    for (const type of ['pan_card', 'aadhaar_card', 'shop_photo']) {
      assert.equal((await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type })).status, 200, type);
    }
  } finally {
    cloud.restore();
  }
  const res = await call('POST', '/onboarding/submit', undefined, headers);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.missing, []);
  assert.ok((await Seller.findById(seller._id).lean()).submittedAt);

  const status = await srv.get('/api/seller/status', headers);
  assert.equal(status.body.data.status, 'pending');
  assert.ok(status.body.data.submittedAt);
});

test('a rejected application can be fixed and resubmitted', async () => {
  const { seller, headers } = await makeCompleteSeller({ status: 'rejected', categoryId: category._id });
  await Seller.updateOne({ _id: seller._id }, { rejectionReason: 'PAN card unreadable' });
  const status = await srv.get('/api/seller/status', headers);
  assert.equal(status.body.data.rejectionReason, 'PAN card unreadable');

  assert.equal((await call('PUT', '/onboarding/owner', ownerBody(), headers)).status, 200, 'editable while rejected');
  const res = await call('POST', '/onboarding/submit', undefined, headers);
  assert.equal(res.status, 200);
  const after = await Seller.findById(seller._id).lean();
  assert.equal(after.status, 'pending');
  assert.equal(after.rejectionReason, null);
});

test('status is readable by every role of a seller in any state', async () => {
  const { seller } = await makeCompleteSeller({ status: 'suspended', categoryId: category._id });
  const emp = await SellerUser.create({ sellerId: seller._id, name: 'E', phone: '9555555555', role: 'employee' });
  const res = await srv.get('/api/seller/status', sellerHeaders(emp));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'suspended');
  assert.equal(res.body.data.rejectionReason, null);
});

// ── After approval ────────────────────────────────────────────────────────────

test('an approved seller may change only its contact details', async () => {
  const { headers, seller } = await makeCompleteSeller({ status: 'active', categoryId: category._id });

  const locked = await call('PUT', '/onboarding/business', { businessName: 'New Name', businessPhone: '9822222222' }, headers);
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'ONBOARDING_LOCKED');
  assert.deepEqual(locked.body.details.lockedFields, ['businessName']);

  const contact = await call(
    'PUT',
    '/onboarding/business',
    { businessPhone: '9822222222', address: { line1: '99 New Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560002' } },
    headers
  );
  assert.equal(contact.status, 200, JSON.stringify(contact.body));
  const stored = await Seller.findById(seller._id).lean();
  assert.equal(stored.businessPhone, '9822222222');
  assert.equal(stored.businessName, 'Glow Salon');
  assert.equal((await onboarding(headers)).body.data.editable, false);

  assert.equal((await call('PUT', '/onboarding/owner', ownerBody(), headers)).status, 409);
  assert.equal((await call('PUT', '/onboarding/employees', { employees: [] }, headers)).status, 409);
  assert.equal((await call('POST', '/onboarding/submit', undefined, headers)).status, 409);
  const cloud = await mockCloudinary();
  try {
    assert.equal((await uploadFile(srv.base, '/api/seller/onboarding/documents', headers, { type: 'shop_photo' })).status, 409);
  } finally {
    cloud.restore();
  }
});
