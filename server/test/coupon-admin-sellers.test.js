// CB3 — super admin: coupon partners. The list with its filters and paging, the masked detail,
// the audited PAN reveal, the approve / reject / suspend / reactivate state machine (with team
// activation and sign-out), users, documents, and that only admins get in. In-memory MongoDB,
// in-memory Redis stand-in.

import test, { after, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { VALID, makeCategory, makeCompleteSeller, sellerHeaders } = await import('../test-utils/sellerFixtures.mjs');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: User } = await import('../models/User.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');

const redis = fakeRedis();
let mongo;
let srv;
let admin;
let adminHeaders;
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
  admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  category = await makeCategory({ key: 'salon', name: 'Salon' });
});

const url = (path = '') => `/api/admin/sellers${path}`;
const get = (path, headers = adminHeaders) => srv.get(url(path), headers);
const act = (method, path, body, headers = adminHeaders) => srv.request(method, url(path), { body, headers });
const logsFor = (sellerId, action) => AdminActivityLog.find({ targetType: 'seller', targetId: sellerId, ...(action ? { action } : {}) }).lean();

// ── Access ────────────────────────────────────────────────────────────────────

test('only admins get in: no token, a customer, an owner and a seller session are refused', async () => {
  const { seller, headers: sellerSession } = await makeCompleteSeller({ categoryId: category._id });
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  const as = (u, role) => ({ authorization: `Bearer ${auth.generateTokens(u._id, role).accessToken}` });

  const routes = [
    ['GET', ''],
    ['GET', `/${seller._id}`],
    ['GET', `/${seller._id}/users`],
    ['POST', `/${seller._id}/reveal`, { field: 'pan' }],
    ['PATCH', `/${seller._id}/approve`],
    ['PATCH', `/${seller._id}/reject`, { reason: 'Nope nope' }],
    ['PATCH', `/${seller._id}/suspend`],
    ['PATCH', `/${seller._id}/reactivate`],
    ['GET', `/${seller._id}/documents/${seller.documents[0]._id}/file`],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await act(method, path, body, {})).status, 401, `${method} ${path} without a token`);
    assert.equal((await act(method, path, body, as(customer, 'customer'))).status, 403, `${method} ${path} as customer`);
    assert.equal((await act(method, path, body, as(owner, 'restaurant_owner'))).status, 403, `${method} ${path} as owner`);
    assert.equal((await act(method, path, body, sellerSession)).status, 401, `${method} ${path} as seller`);
  }
  assert.equal((await Seller.findById(seller._id).lean()).status, 'pending', 'nothing changed');
});

// ── List ──────────────────────────────────────────────────────────────────────

test('the list filters by status, category and search, pages, and counts by status', async () => {
  const spa = await makeCategory({ key: 'spa', name: 'Spa' });
  const a = await makeCompleteSeller({ categoryId: category._id, phone: '9000000011' });
  const b = await makeCompleteSeller({ categoryId: spa._id, phone: '9000000012', status: 'active' });
  const c = await makeCompleteSeller({ categoryId: spa._id, phone: '9000000013', status: 'rejected' });
  await Seller.updateOne({ _id: b.seller._id }, { businessName: 'Lotus Spa' });

  const all = await get('');
  assert.equal(all.status, 200);
  assert.equal(all.body.data.total, 3);
  assert.deepEqual(all.body.data.statusCounts, { pending: 1, active: 1, suspended: 0, rejected: 1 });
  const row = all.body.data.sellers.find((s) => s._id === String(a.seller._id));
  assert.equal(row.category.name, 'Salon');
  assert.equal(row.ownerPhone, '9000000011');
  assert.equal(row.complete, true);

  assert.deepEqual((await get('?status=active')).body.data.sellers.map((s) => s._id), [String(b.seller._id)]);
  assert.equal((await get(`?categoryId=${spa._id}`)).body.data.total, 2);
  assert.deepEqual((await get('?search=lotus')).body.data.sellers.map((s) => s._id), [String(b.seller._id)]);
  assert.deepEqual((await get('?search=9000000013')).body.data.sellers.map((s) => s._id), [String(c.seller._id)], 'by owner phone');
  assert.equal((await get('?search=.*')).body.data.total, 0, 'search is literal, not a regex');

  const page1 = await get('?limit=2&page=1');
  const page2 = await get('?limit=2&page=2');
  assert.equal(page1.body.data.sellers.length, 2);
  assert.equal(page2.body.data.sellers.length, 1);
  assert.equal(page1.body.data.pages, 2);

  for (const bad of ['?status=approved', '?categoryId=nope', '?limit=500', '?page=0']) {
    assert.equal((await get(bad)).status, 400, bad);
  }
});

// ── Detail & reveal ───────────────────────────────────────────────────────────

test('the detail is complete but masked; bad and unknown ids are refused', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  const res = await get(`/${seller._id}`);
  assert.equal(res.status, 200);
  const s = res.body.data.seller;
  assert.equal(s.business.businessName, 'Glow Salon');
  assert.equal(s.business.category.name, 'Salon');
  assert.equal(s.owner.panMasked, '******234F');
  assert.equal(s.owner.aadhaarMasked, 'XXXX XXXX 2346');
  assert.equal(s.owner.panRevealable, true);
  assert.equal(s.documents.length, 2);
  assert.equal(s.documents[0].url, undefined);
  assert.deepEqual(s.missing, []);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(VALID.pan) && !text.includes('panEncrypted') && !text.includes('v1:'));

  assert.equal((await get('/nope')).status, 400);
  assert.equal((await get(`/${new mongoose.Types.ObjectId()}`)).status, 404);
});

test('revealing the PAN returns it once, no-store, and writes the activity log', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  const res = await act('POST', `/${seller._id}/reveal`, { field: 'pan' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.value, VALID.pan);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const logs = await logsFor(seller._id, 'seller.reveal_pan');
  assert.equal(logs.length, 1);
  assert.equal(String(logs[0].adminId), String(admin._id));
  assert.equal(logs[0].metadata.panLast4, '234F');
  assert.ok(!JSON.stringify(logs[0]).includes(VALID.pan), 'the log never holds the number');
});

test('Aadhaar cannot be revealed (it is never stored), and bad requests are refused', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  const aadhaar = await act('POST', `/${seller._id}/reveal`, { field: 'aadhaar' });
  assert.equal(aadhaar.status, 404);
  assert.equal(aadhaar.body.code, 'NOT_STORED');
  assert.equal((await act('POST', `/${seller._id}/reveal`, { field: 'gst' })).status, 400);
  assert.equal((await act('POST', `/${seller._id}/reveal`, {})).status, 400);

  await Seller.updateOne({ _id: seller._id }, { 'owner.panEncrypted': null, 'owner.panLast4': null });
  assert.equal((await act('POST', `/${seller._id}/reveal`, { field: 'pan' })).status, 404);
  assert.equal((await logsFor(seller._id)).length, 0, 'nothing revealed, nothing logged');
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

test('approve activates the seller and its team, except anyone removed, and is logged', async () => {
  const { seller, headers } = await makeCompleteSeller({ categoryId: category._id });
  await SellerUser.create({ sellerId: seller._id, name: 'Ravi', phone: '9333333333', role: 'employee', isActive: false });
  await SellerUser.create({ sellerId: seller._id, name: 'Gone', phone: '9444444444', role: 'employee', isActive: false, removedAt: new Date() });

  const res = await act('PATCH', `/${seller._id}/approve`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.seller.status, 'active');
  const stored = await Seller.findById(seller._id).lean();
  assert.equal(String(stored.reviewedBy), String(admin._id));
  assert.ok(stored.reviewedAt);
  assert.equal((await SellerUser.findOne({ phone: '9333333333' }).lean()).isActive, true);
  assert.equal((await SellerUser.findOne({ phone: '9444444444' }).lean()).isActive, false, 'removed stays removed');

  const [log] = await logsFor(seller._id, 'SELLER_APPROVED');
  assert.equal(log.metadata.usersActivated, 1);
  // The owner's existing session sees the new status at once.
  assert.equal((await srv.get('/api/seller/status', headers)).body.data.status, 'active');
});

test('approve refuses an application that was never submitted or is incomplete', async () => {
  const draft = await makeCompleteSeller({ categoryId: category._id, submitted: false, phone: '9000000021' });
  const r1 = await act('PATCH', `/${draft.seller._id}/approve`);
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'NOT_SUBMITTED');

  const partial = await makeCompleteSeller({ categoryId: category._id, phone: '9000000022' });
  await Seller.updateOne({ _id: partial.seller._id }, { $pull: { documents: { type: 'aadhaar_card' } } });
  const r2 = await act('PATCH', `/${partial.seller._id}/approve`);
  assert.equal(r2.status, 409);
  assert.deepEqual(r2.body.details.missing, ['document:aadhaar_card']);
});

test('reject needs a reason, shows it to the owner, and is logged', async () => {
  const { seller, headers } = await makeCompleteSeller({ categoryId: category._id });
  assert.equal((await act('PATCH', `/${seller._id}/reject`, {})).status, 400);
  assert.equal((await act('PATCH', `/${seller._id}/reject`, { reason: 'no' })).status, 400);

  const res = await act('PATCH', `/${seller._id}/reject`, { reason: 'PAN card photo is blurred' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.seller.status, 'rejected');
  const status = (await srv.get('/api/seller/status', headers)).body.data;
  assert.equal(status.status, 'rejected');
  assert.equal(status.rejectionReason, 'PAN card photo is blurred');
  const [log] = await logsFor(seller._id, 'SELLER_REJECTED');
  assert.equal(log.metadata.reason, 'PAN card photo is blurred');
});

test('suspend signs every user out; reactivate lets them sign in again', async () => {
  const { seller, owner } = await makeCompleteSeller({ categoryId: category._id, status: 'active' });
  const emp = await SellerUser.create({ sellerId: seller._id, name: 'Ravi', phone: '9333333333', role: 'employee' });
  const ownerSession = sellerHeaders(owner);
  const empSession = sellerHeaders(emp);
  assert.equal((await srv.get('/api/seller/auth/me', empSession)).status, 200);

  const res = await act('PATCH', `/${seller._id}/suspend`, { reason: 'Customer complaints' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.seller.status, 'suspended');
  assert.equal((await srv.get('/api/seller/auth/me', ownerSession)).status, 401);
  assert.equal((await srv.get('/api/seller/auth/me', empSession)).status, 401);
  // Signing in again shows the suspension rather than the business.
  const fresh = sellerHeaders(await SellerUser.findById(owner._id).lean());
  assert.equal((await srv.get('/api/seller/status', fresh)).body.data.status, 'suspended');

  const back = await act('PATCH', `/${seller._id}/reactivate`);
  assert.equal(back.status, 200);
  assert.equal(back.body.data.seller.status, 'active');
  assert.equal((await logsFor(seller._id, 'SELLER_SUSPENDED')).length, 1);
  assert.equal((await logsFor(seller._id, 'SELLER_REACTIVATED')).length, 1);
});

test('the state machine refuses every transition that is not allowed', async () => {
  // [current status, action, body]
  const illegal = [
    ['active', 'approve'],
    ['suspended', 'approve'],
    ['rejected', 'approve'],
    ['active', 'reject', { reason: 'Too late now' }],
    ['suspended', 'reject', { reason: 'Too late now' }],
    ['rejected', 'reject', { reason: 'Twice over' }],
    ['pending', 'suspend'],
    ['suspended', 'suspend'],
    ['rejected', 'suspend'],
    ['pending', 'reactivate'],
    ['active', 'reactivate'],
    ['rejected', 'reactivate'],
  ];
  let n = 30;
  for (const [status, action, body] of illegal) {
    const { seller } = await makeCompleteSeller({ categoryId: category._id, status, phone: `90000000${(n += 1)}` });
    const res = await act('PATCH', `/${seller._id}/${action}`, body);
    assert.equal(res.status, 409, `${action} from ${status}`);
    assert.equal(res.body.code, 'INVALID_STATE', `${action} from ${status}`);
    assert.equal((await Seller.findById(seller._id).lean()).status, status, 'unchanged');
  }
  assert.equal(await AdminActivityLog.countDocuments({ targetType: 'seller' }), 0, 'refused actions are not logged');
  assert.equal((await act('PATCH', `/${new mongoose.Types.ObjectId()}/approve`)).status, 404);
});

test('two admins approving at once: exactly one succeeds', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  const results = await Promise.all([act('PATCH', `/${seller._id}/approve`), act('PATCH', `/${seller._id}/approve`)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await logsFor(seller._id, 'SELLER_APPROVED')).length, 1);
});

// ── Users & documents ─────────────────────────────────────────────────────────

test('users lists every login on the account, removed ones included, with phones', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  await SellerUser.create({ sellerId: seller._id, name: 'Ravi', phone: '9333333333', role: 'employee', passwordHash: 'secret-hash' });
  await SellerUser.create({ sellerId: seller._id, name: 'Gone', phone: '9444444444', role: 'manager', isActive: false, removedAt: new Date() });
  const res = await get(`/${seller._id}/users`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.users.map((u) => u.role).sort(), ['employee', 'manager', 'owner']);
  assert.ok(res.body.data.users.find((u) => u.name === 'Gone').removedAt);
  assert.ok(!JSON.stringify(res.body).includes('secret-hash'));
  assert.equal((await get(`/${new mongoose.Types.ObjectId()}/users`)).status, 404);
});

test('a document is streamed through the API with its recorded type', async () => {
  const { seller } = await makeCompleteSeller({ categoryId: category._id });
  const realFetch = globalThis.fetch;
  const stub = mock.method(globalThis, 'fetch', async (input, init) =>
    String(input).startsWith('https://res.example.invalid/')
      ? new Response('PNGBYTES', { headers: { 'content-type': 'application/octet-stream' } })
      : realFetch(input, init)
  );
  try {
    const docId = seller.documents[0]._id;
    const res = await fetch(`${srv.base}${url(`/${seller._id}/documents/${docId}/file`)}`, { headers: adminHeaders });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(await res.text(), 'PNGBYTES');
    assert.equal((await get(`/${seller._id}/documents/${new mongoose.Types.ObjectId()}/file`)).status, 404);
  } finally {
    stub.mock.restore();
  }
});
