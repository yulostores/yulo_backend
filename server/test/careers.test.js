// Careers portal: the public application form (validation, PDF résumé, ₹100 form fee through
// Razorpay — verify, webhook, retries, duplicates) and the super admin's list, detail, status,
// notes, résumé and CSV export. Fake Razorpay, in-memory MongoDB, Cloudinary mocked.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  webhookSignature,
  paymentCapturedEvent,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { mockCloudinary } = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __setClockForTests } = await import('../utils/clock.js');
const auth = await import('../services/auth.service.js');
const { applyLimiter, applyLimiterKey } = await import('../routes/careers.routes.js');
const { ageOn } = await import('../services/jobApplication.service.js');
const { default: JobApplication } = await import('../models/JobApplication.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: User } = await import('../models/User.js');

let mongo;
let srv;
let fake;
let cloud;
let adminHeaders;
let customerHeaders;

// 22 Nov 2026, 10:00 IST.
const NOW = new Date('2026-11-22T04:30:00.000Z');

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([JobApplication.init(), StrayPayment.init(), WebhookEvent.init()]);
  srv = await startTestServer();
});
after(async () => {
  __setRazorpayForTests(undefined);
  __setClockForTests(null);
  cloud?.restore();
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  await applyLimiter.resetKey(applyLimiterKey('127.0.0.1'));
  await applyLimiter.resetKey(applyLimiterKey('::1'));
  await applyLimiter.resetKey(applyLimiterKey('::ffff:127.0.0.1'));
  __setClockForTests(() => NOW);
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  cloud?.restore();
  cloud = await mockCloudinary();
  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  customerHeaders = { authorization: `Bearer ${auth.generateTokens(customer._id, 'customer').accessToken}` };
});

const VALID = {
  fullName: 'Asha Verma',
  phone: '+91 98765 43210',
  dateOfBirth: '2000-11-23', // 25 on 22 Nov 2026 (birthday is tomorrow)
  gender: 'female',
  city: 'Indore',
  department: 'social_media',
  role: 'influencer',
  expectedSalaryMin: '15000',
  expectedSalaryMax: '25000',
};

const PDF = '%PDF-1.4\n%fake resume\n';

const apply = async (fields = {}, { resume, name = 'resume.pdf', mime = 'application/pdf' } = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ ...VALID, ...fields })) if (v !== undefined) form.append(k, v);
  if (resume !== undefined) form.append('resume', new Blob([Buffer.from(resume)], { type: mime }), name);
  const res = await fetch(`${srv.base}/api/careers/applications`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
};

const careers = (method, path, body, token) =>
  srv.request(method, `/api/careers${path}`, { body, headers: token ? { 'x-application-token': token } : {} });
const admin$ = (method, path, body, headers = adminHeaders) => srv.request(method, `/api/admin/job-applications${path}`, { body, headers });

let paySeq = 0;
const payFor = (razorpayOrderId, over = {}) =>
  fake.addPayment({ id: `pay_job_${++paySeq}`, order_id: razorpayOrderId, amount: 10_000, status: 'captured', ...over });

const verifyBody = (payment) => ({
  razorpay_order_id: payment.order_id,
  razorpay_payment_id: payment.id,
  razorpay_signature: checkoutSignature(payment.order_id, payment.id),
});

const deliverWebhook = (payment, type = 'payment.captured') => {
  const raw = JSON.stringify(paymentCapturedEvent(payment, type));
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': `evt_${Math.random()}` },
  });
};

/** A submitted (paid) application; returns { id, token }. */
const submitted = async (fields = {}, opts = {}) => {
  const created = await apply(fields, opts);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { application, accessToken, razorpayOrder } = created.body.data;
  const payment = payFor(razorpayOrder.id);
  const v = await careers('POST', `/applications/${application.id}/verify`, verifyBody(payment), accessToken);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { id: application.id, token: accessToken, payment };
};

// ── Public ────────────────────────────────────────────────────────────────────

test('positions: every department with its roles, the education levels and the ₹100 fee', async () => {
  const res = await careers('GET', '/positions');
  assert.equal(res.status, 200);
  const { departments, feePaise, feeRupees, educationLevels } = res.body.data;
  assert.equal(feePaise, 10_000);
  assert.equal(feeRupees, 100);
  // Business Development is folded into Sales: 10 positions on the form.
  assert.equal(departments.length, 10);
  assert.ok(!departments.some((d) => d.key === 'business_development'));
  assert.deepEqual(
    departments.find((d) => d.key === 'social_media').roles.map((r) => r.label),
    ['Social Media Manager', 'Content Creator', 'Social Media Strategist', 'Influencer', 'Small Reel Creator']
  );
  assert.deepEqual(departments.find((d) => d.key === 'restaurant').roles.map((r) => r.label), [
    'Chef, Cook, Chinese Chef, Halwai',
    'Waiter',
    'Kitchen Helper',
    'Cleaner & Helper',
    'Restaurant, Cafe Manager',
    'Counter Billing Executive',
  ]);
  assert.equal(departments.find((d) => d.key === 'designing').label, 'Designing & Creating');
  // Retired roles are not offered (older applications keep their labels).
  assert.ok(!departments.find((d) => d.key === 'designing').roles.some((r) => r.key === 'editor'));
  assert.ok(departments.find((d) => d.key === 'sales').roles.some((r) => r.key === 'business_development_executive'));
  assert.ok(educationLevels.some((e) => e.key === 'graduate'));
});

test('apply: saves the application unpaid, uploads the PDF resume and opens a ₹100 Razorpay order', async () => {
  const res = await apply(
    { alternatePhone: '09123456789', currentSalary: '12000', availableFrom: '2026-12-01', education: 'graduate', experienceYears: '2', experience: 'Two years making reels' },
    { resume: PDF }
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { application, accessToken, razorpayOrder, paymentSimulated } = res.body.data;
  assert.equal(application.paid, false);
  assert.equal(application.applicationNumber, null);
  assert.equal(application.roleLabel, 'Influencer');
  assert.equal(application.departmentLabel, 'Social Media');
  assert.match(accessToken, /^[a-f0-9]{64}$/);
  assert.equal(razorpayOrder.amount, 10_000);
  assert.equal(paymentSimulated, false);
  assert.equal(fake.calls.ordersCreate[0].notes.kind, 'job_application');

  const saved = await JobApplication.findById(application.id).select('+accessTokenHash').lean();
  assert.equal(saved.status, 'pending_payment');
  assert.equal(saved.phone, '9876543210');
  assert.equal(saved.alternatePhone, '9123456789');
  assert.equal(saved.dateOfBirth.toISOString(), '2000-11-23T00:00:00.000Z');
  assert.equal(saved.payment.razorpayOrderId, razorpayOrder.id);
  assert.notEqual(saved.accessTokenHash, accessToken, 'only the hash is stored');
  assert.equal(saved.resume.mimeType, 'application/pdf');
  assert.equal(cloud.uploads.length, 1);
  assert.equal(cloud.uploads[0].resource_type, 'raw');
});

test('apply: optional fields can be left blank, and the resume is optional', async () => {
  const res = await apply({ alternatePhone: '', currentSalary: '', availableFrom: '', education: '', experienceYears: '', experience: '' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const saved = await JobApplication.findById(res.body.data.application.id).lean();
  assert.equal(saved.resume, null);
  assert.equal(saved.currentSalary, null);
  assert.equal(cloud.uploads.length, 0);
});

test('apply: refuses bad input field by field', async () => {
  const cases = [
    [{ fullName: '' }, 'fullName'],
    [{ phone: '12345' }, 'phone'],
    [{ alternatePhone: '9876543210' }, 'alternatePhone'], // same as the mobile number
    [{ dateOfBirth: '2000-02-30' }, 'dateOfBirth'],
    [{ gender: 'x' }, 'gender'],
    [{ city: '' }, 'city'],
    [{ department: 'astronaut' }, 'department'],
    [{ expectedSalaryMin: '30000', expectedSalaryMax: '20000' }, 'expectedSalaryMax'],
    [{ expectedSalaryMin: 'abc' }, 'expectedSalaryMin'],
    [{ education: 'phd' }, 'education'],
  ];
  for (const [fields, field] of cases) {
    const res = await apply(fields);
    assert.equal(res.status, 400, `${field}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.ok(res.body.details?.fieldErrors?.[field], `${field} flagged: ${JSON.stringify(res.body.details)}`);
  }
  // A role from another position.
  const wrongRole = await apply({ department: 'sales', role: 'influencer' });
  assert.equal(wrongRole.status, 400);
  assert.ok(wrongRole.body.details.fieldErrors.role);
  // Too young (15 on the day), and a joining date in the past.
  const young = await apply({ dateOfBirth: '2011-01-01' });
  assert.equal(young.status, 400);
  assert.ok(young.body.details.fieldErrors.dateOfBirth);
  const past = await apply({ availableFrom: '2026-11-21' });
  assert.equal(past.status, 400);
  assert.ok(past.body.details.fieldErrors.availableFrom);
  // Unknown fields are refused.
  assert.equal((await apply({ isAdmin: 'true' })).status, 400);
  assert.equal(await JobApplication.countDocuments(), 0);
  assert.equal(fake.calls.ordersCreate.length, 0);
});

test('apply: the resume must really be a PDF', async () => {
  const image = await apply({}, { resume: 'PNGDATA', name: 'cv.png', mime: 'image/png' });
  assert.equal(image.status, 400);
  assert.equal(image.body.code, 'INVALID_FILE_TYPE');
  const disguised = await apply({}, { resume: 'MZ not a pdf', name: 'cv.pdf', mime: 'application/pdf' });
  assert.equal(disguised.status, 400);
  assert.equal(disguised.body.code, 'INVALID_FILE_TYPE');
  const huge = await apply({}, { resume: `%PDF-${'x'.repeat(5 * 1024 * 1024)}` });
  assert.equal(huge.status, 400);
  assert.equal(await JobApplication.countDocuments(), 0);
});

test('verify: a good payment submits the application, numbered YJ-000001; the token is required', async () => {
  const created = (await apply()).body.data;
  const payment = payFor(created.razorpayOrder.id);
  const path = `/applications/${created.application.id}/verify`;

  assert.equal((await careers('POST', path, verifyBody(payment))).status, 404, 'no token');
  assert.equal((await careers('POST', path, verifyBody(payment), 'f'.repeat(64))).status, 404, 'wrong token');
  const badSig = await careers('POST', path, { ...verifyBody(payment), razorpay_signature: 'a'.repeat(64) }, created.accessToken);
  assert.equal(badSig.status, 400);
  assert.equal(badSig.body.code, 'PAYMENT_VERIFICATION_FAILED');

  const ok = await careers('POST', path, verifyBody(payment), created.accessToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.application.paid, true);
  assert.equal(ok.body.data.application.applicationNumber, 'YJ-000001');

  const saved = await JobApplication.findById(created.application.id).lean();
  assert.equal(saved.status, 'new');
  assert.equal(saved.payment.status, 'paid');
  assert.equal(saved.payment.confirmedVia, 'verify');
  assert.equal(saved.payment.razorpayPaymentId, payment.id);

  // Verifying again is a no-op, and the status read works with the token.
  assert.equal((await careers('POST', path, verifyBody(payment), created.accessToken)).status, 200);
  const read = await careers('GET', `/applications/${created.application.id}`, undefined, created.accessToken);
  assert.equal(read.body.data.application.applicationNumber, 'YJ-000001');
});

test('verify: a payment for the wrong amount is refused and owed back', async () => {
  const created = (await apply()).body.data;
  const payment = payFor(created.razorpayOrder.id, { amount: 5_000 });
  const res = await careers('POST', `/applications/${created.application.id}/verify`, verifyBody(payment), created.accessToken);
  assert.equal(res.status, 400);
  assert.equal((await JobApplication.findById(created.application.id).lean()).status, 'pending_payment');
  const stray = await StrayPayment.findOne({ razorpayPaymentId: payment.id }).lean();
  assert.equal(stray.kind, 'job_application_payment_refused');
  assert.equal(String(stray.jobApplicationId), created.application.id);
});

test('webhook: settles the application when the browser never came back', async () => {
  const created = (await apply()).body.data;
  const payment = payFor(created.razorpayOrder.id);
  const res = await deliverWebhook(payment);
  assert.equal(res.status, 200);
  const saved = await JobApplication.findById(created.application.id).lean();
  assert.equal(saved.status, 'new');
  assert.equal(saved.payment.confirmedVia, 'webhook');
  // The browser's verify afterwards still answers success.
  const v = await careers('POST', `/applications/${created.application.id}/verify`, verifyBody(payment), created.accessToken);
  assert.equal(v.status, 200);
});

test('retry: a new Razorpay order for an unpaid application; a payment on the old one still counts', async () => {
  const created = (await apply()).body.data;
  const retry = await careers('POST', `/applications/${created.application.id}/pay`, undefined, created.accessToken);
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.data.razorpayOrder.id, created.razorpayOrder.id);

  const late = payFor(created.razorpayOrder.id);
  assert.equal((await deliverWebhook(late)).status, 200);
  assert.equal((await JobApplication.findById(created.application.id).lean()).status, 'new');

  // Paid: no more retries, and a second payment is owed back.
  const again = await careers('POST', `/applications/${created.application.id}/pay`, undefined, created.accessToken);
  assert.equal(again.status, 409);
  const second = payFor(retry.body.data.razorpayOrder.id);
  const dup = await careers('POST', `/applications/${created.application.id}/verify`, verifyBody(second), created.accessToken);
  assert.equal(dup.status, 409);
  assert.equal((await StrayPayment.findOne({ razorpayPaymentId: second.id }).lean()).kind, 'job_application_duplicate_payment');
});

test('apply: one live application per mobile number and role', async () => {
  await submitted();
  const again = await apply({ phone: '9876543210' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ALREADY_APPLIED');
  // Another role is fine.
  assert.equal((await apply({ department: 'designing', role: 'video_editor' })).status, 201);
  // After a rejection the same role is open again.
  await JobApplication.updateMany({ role: 'influencer', 'payment.status': 'paid' }, { $set: { status: 'rejected' } });
  assert.equal((await apply()).status, 201);
});

test('apply: up to 3 roles in one position; retired or other-position roles are refused', async () => {
  const three = await apply({ role: undefined, roles: 'content_creator,influencer,small_reel_creator' });
  assert.equal(three.status, 201, JSON.stringify(three.body));
  assert.equal(three.body.data.application.roleLabel, 'Content Creator, Influencer, Small Reel Creator');
  const saved = await JobApplication.findById(three.body.data.application.id).lean();
  assert.deepEqual(saved.roles, ['content_creator', 'influencer', 'small_reel_creator']);
  assert.equal(saved.role, 'content_creator', 'the first role is kept as `role` for older screens');

  assert.equal((await apply({ role: undefined, roles: 'content_creator,influencer,small_reel_creator,social_media_manager' })).status, 400, 'four is too many');
  assert.equal((await apply({ role: undefined, roles: 'content_creator,waiter' })).status, 400, 'a role from another position');
  assert.equal((await apply({ department: 'designing', role: 'editor' })).status, 400, 'a retired role');
  assert.equal((await apply({ department: 'business_development', role: 'business_development_executive' })).status, 400, 'a retired position');
});

test('apply: a role already in a live application is refused, even inside a multi-role one', async () => {
  const first = await apply({ role: undefined, roles: 'content_creator,influencer' });
  await JobApplication.updateOne({ _id: first.body.data.application.id }, { $set: { 'payment.status': 'paid', status: 'new' } });
  const again = await apply({ role: undefined, roles: 'small_reel_creator,influencer' });
  assert.equal(again.status, 409);
  assert.match(again.body.message, /Influencer/);
  assert.equal((await apply({ role: undefined, roles: 'small_reel_creator' })).status, 201, 'a different role is fine');
});

test('simulate-payment is off unless local simulation is enabled', async () => {
  const created = (await apply()).body.data;
  const res = await careers('POST', `/applications/${created.application.id}/simulate-payment`, undefined, created.accessToken);
  assert.equal(res.status, 404);
});

// ── Admin ─────────────────────────────────────────────────────────────────────

test('ageOn counts whole years in India, birthdays included', () => {
  const on = new Date('2026-11-22T00:00:00.000Z');
  assert.equal(ageOn(new Date('2000-11-22T00:00:00.000Z'), on), 26);
  assert.equal(ageOn(new Date('2000-11-23T00:00:00.000Z'), on), 25);
  assert.equal(ageOn(new Date('2008-02-29T00:00:00.000Z'), on), 18);
});

test('admin routes need an admin', async () => {
  assert.equal((await admin$('GET', '', undefined, {})).status, 401);
  assert.equal((await admin$('GET', '', undefined, customerHeaders)).status, 403);
});

test('admin list: every application, paid or not, with age next to the date of birth, filters and counts', async () => {
  const a = await submitted();
  await submitted({ fullName: 'Ravi Kumar', phone: '9811111111', gender: 'male', city: 'Bhopal', department: 'developer', role: 'backend', dateOfBirth: '1995-01-10' });
  await apply({ fullName: 'Unpaid Person', phone: '9822222222' }); // never paid

  const list = await admin$('GET', '');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 3);
  assert.equal(list.body.data.counts.new, 2);
  assert.equal(list.body.data.counts.pending_payment, 1);
  const unpaidRow = list.body.data.applications.find((r) => r.fullName === 'Unpaid Person');
  assert.equal(unpaidRow.paid, false);
  assert.equal(unpaidRow.status, 'pending_payment');
  assert.equal(unpaidRow.applicationNumber, null);
  const asha = list.body.data.applications.find((r) => r._id === a.id);
  assert.equal(asha.dateOfBirth, '2000-11-23');
  assert.equal(asha.age, 25);
  assert.equal(asha.roleLabel, 'Influencer');
  assert.equal(asha.phone, '9876543210');

  assert.equal((await admin$('GET', '?status=pending_payment')).body.data.total, 1);
  assert.equal((await admin$('GET', '?status=new')).body.data.total, 2);
  assert.equal((await admin$('GET', '?department=developer')).body.data.applications[0].fullName, 'Ravi Kumar');
  assert.equal((await admin$('GET', '?role=influencer')).body.data.total, 2, 'the paid and the unpaid influencer');
  assert.equal((await admin$('GET', '?gender=male')).body.data.total, 1);
  assert.equal((await admin$('GET', '?city=bho')).body.data.total, 1);
  assert.equal((await admin$('GET', '?q=98111')).body.data.total, 1);
  assert.equal((await admin$('GET', '?q=asha')).body.data.total, 1);
  assert.equal((await admin$('GET', '?q=YJ-000002')).body.data.total, 1);
  assert.equal((await admin$('GET', '?q=(.*')).status, 200, 'search text is not a regex');
  assert.equal((await admin$('GET', '?department=nope')).status, 400);
});

test('admin detail, status changes with a note, notes, resume and CSV', async () => {
  const { id } = await submitted({ currentSalary: '9000', education: '12th', experience: 'Some' }, { resume: PDF });
  const detail = await admin$('GET', `/${id}`);
  assert.equal(detail.status, 200);
  const app = detail.body.data.application;
  assert.equal(app.age, 25);
  assert.equal(app.educationLabel, '12th pass');
  assert.equal(app.currentSalary, 9000);
  assert.equal(app.resume.name, 'resume.pdf');
  assert.equal(app.resume.url, undefined, 'the storage URL never leaves the API');
  assert.equal(app.payment.status, 'paid');

  const shortlisted = await admin$('PATCH', `/${id}/status`, { status: 'shortlisted', note: 'Good portfolio' });
  assert.equal(shortlisted.status, 200);
  assert.equal(shortlisted.body.data.application.status, 'shortlisted');
  assert.equal(shortlisted.body.data.application.notes[0].text, 'Good portfolio');
  assert.equal((await admin$('PATCH', `/${id}/status`, { status: 'pending_payment' })).status, 400);

  const noted = await admin$('POST', `/${id}/notes`, { text: 'Call on Monday' });
  assert.equal(noted.status, 201);
  assert.equal(noted.body.data.application.notes[0].text, 'Call on Monday');
  assert.equal(noted.body.data.application.notes.length, 2);

  // An unpaid application cannot be moved along.
  const unpaid = (await apply({ phone: '9833333333' })).body.data.application.id;
  assert.equal((await admin$('PATCH', `/${unpaid}/status`, { status: 'hired' })).status, 409);

  const res = await fetch(`${srv.base}/api/admin/job-applications/export.csv`, { headers: adminHeaders });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /Application No,Submitted,Full Name/);
  assert.match(csv, /YJ-000001/);
  assert.match(csv, /Influencer/);
  assert.match(csv, /9833333333/, 'unpaid applications are exported too');

  assert.equal((await admin$('GET', '/000000000000000000000000')).status, 404);
  assert.equal((await admin$('GET', `/${unpaid}/resume`)).status, 404);
});
