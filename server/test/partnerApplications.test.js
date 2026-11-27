// "Choose your business" on the careers portal: a shop applying to become a Yulo coupon partner,
// with a ₹100 form fee (verify, webhook, refused payments), and the super admin's list, detail,
// status, notes, CSV and the Transactions ledger. Fake Razorpay, in-memory MongoDB.

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
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __setClockForTests } = await import('../utils/clock.js');
const auth = await import('../services/auth.service.js');
const { applyLimiter, applyLimiterKey } = await import('../routes/careers.routes.js');
const { default: PartnerApplication } = await import('../models/PartnerApplication.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: User } = await import('../models/User.js');

let mongo;
let srv;
let fake;
let adminHeaders;

const NOW = new Date('2026-11-28T04:30:00.000Z');

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([PartnerApplication.init(), StrayPayment.init(), WebhookEvent.init()]);
  srv = await startTestServer();
});
after(async () => {
  __setRazorpayForTests(undefined);
  __setClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) await applyLimiter.resetKey(applyLimiterKey(ip));
  __setClockForTests(() => NOW);
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
});

const VALID = {
  businessName: 'Glow Unisex Salon',
  category: 'salon',
  address: '12 MG Road, Vijay Nagar',
  city: 'Indore',
  hasGst: true,
  employees: 6,
  ownerName: 'Ravi Sharma',
  phone: '+91 98765 43210',
  questions: 'How do customers find our coupons?',
};

const careers = (method, path, body, token) =>
  srv.request(method, `/api/careers${path}`, { body, headers: token ? { 'x-application-token': token } : {} });
const apply = (fields = {}) => careers('POST', '/partner-applications', { ...VALID, ...fields });
const admin$ = (method, path, body, headers = adminHeaders) => srv.request(method, `/api/admin/partner-applications${path}`, { body, headers });

let paySeq = 0;
const payFor = (orderId, over = {}) => fake.addPayment({ id: `pay_biz_${++paySeq}`, order_id: orderId, amount: 10_000, status: 'captured', ...over });
const verifyBody = (p) => ({ razorpay_order_id: p.order_id, razorpay_payment_id: p.id, razorpay_signature: checkoutSignature(p.order_id, p.id) });
const deliverWebhook = (payment) => {
  const raw = JSON.stringify(paymentCapturedEvent(payment, 'payment.captured'));
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': `evt_${Math.random()}` },
  });
};

const submitted = async (fields = {}) => {
  const created = await apply(fields);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { application, accessToken, razorpayOrder } = created.body.data;
  const payment = payFor(razorpayOrder.id);
  const v = await careers('POST', `/partner-applications/${application.id}/verify`, verifyBody(payment), accessToken);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { id: application.id, token: accessToken, payment };
};

test('form: the categories and the ₹100 fee', async () => {
  const res = await careers('GET', '/partner-form');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.categories.map((c) => c.label), ['Salon', 'Grocery Store', 'Clothes Store', 'Other']);
  assert.equal(res.body.data.feeRupees, 100);
});

test('apply: saved unpaid with a ₹100 Razorpay order; verify submits it as YB-000001', async () => {
  const created = await apply();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { application, accessToken, razorpayOrder } = created.body.data;
  assert.equal(razorpayOrder.amount, 10_000);
  let saved = await PartnerApplication.findById(application.id).lean();
  assert.equal(saved.status, 'pending_payment');
  assert.equal(saved.phone, '9876543210');
  assert.equal(saved.hasGst, true);
  assert.equal(saved.employees, 6);

  const payment = payFor(razorpayOrder.id);
  const path = `/partner-applications/${application.id}/verify`;
  assert.equal((await careers('POST', path, verifyBody(payment))).status, 404, 'no token');
  const ok = await careers('POST', path, verifyBody(payment), accessToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.application.applicationNumber, 'YB-000001');
  saved = await PartnerApplication.findById(application.id).lean();
  assert.equal(saved.status, 'new');
  assert.equal(saved.payment.confirmedVia, 'verify');
});

test('apply: "Other" needs the kind of store typed in; bad input is refused field by field', async () => {
  const other = await apply({ category: 'other' });
  assert.equal(other.status, 400);
  assert.ok(other.body.errors?.fieldErrors?.otherCategory ?? other.body.details?.fieldErrors?.otherCategory, JSON.stringify(other.body));
  const typed = await apply({ category: 'other', otherCategory: 'Mobile shop', phone: '9876500001' });
  assert.equal(typed.status, 201);
  assert.equal((await PartnerApplication.findById(typed.body.data.application.id).lean()).otherCategory, 'Mobile shop');
  // otherCategory is dropped for a listed category.
  const listed = await apply({ category: 'grocery', otherCategory: 'ignored', phone: '9876500002' });
  assert.equal((await PartnerApplication.findById(listed.body.data.application.id).lean()).otherCategory, null);

  for (const bad of [
    { businessName: '' },
    { category: 'bakery' },
    { address: '' },
    { city: '' },
    { hasGst: 'maybe' },
    { employees: -1 },
    { employees: 'many' },
    { ownerName: '' },
    { phone: '12345' },
    { alternatePhone: '9876543210' }, // same as the owner's
  ]) {
    assert.equal((await apply(bad)).status, 400, JSON.stringify(bad));
  }
  // Optional ones may be left out; "false" from a form counts as No.
  const minimal = await apply({ questions: undefined, alternatePhone: '', hasGst: 'false', phone: '9876500003' });
  assert.equal(minimal.status, 201, JSON.stringify(minimal.body));
  assert.equal((await PartnerApplication.findById(minimal.body.data.application.id).lean()).hasGst, false);
});

test('a wrong-amount payment is refused and owed back; the webhook settles a lost browser', async () => {
  const a = (await apply()).body.data;
  const short = payFor(a.razorpayOrder.id, { amount: 5_000 });
  assert.equal((await careers('POST', `/partner-applications/${a.application.id}/verify`, verifyBody(short), a.accessToken)).status, 400);
  const stray = await StrayPayment.findOne({ razorpayPaymentId: short.id }).lean();
  assert.equal(stray.kind, 'partner_application_payment_refused');
  assert.equal(String(stray.partnerApplicationId), a.application.id);

  const good = payFor(a.razorpayOrder.id);
  assert.equal((await deliverWebhook(good)).status, 200);
  const saved = await PartnerApplication.findById(a.application.id).lean();
  assert.equal(saved.status, 'new');
  assert.equal(saved.payment.confirmedVia, 'webhook');
});

test('one live application per owner mobile; a rejected business may apply again', async () => {
  const first = await submitted();
  const again = await apply();
  assert.equal(again.status, 409);
  await admin$('PATCH', `/${first.id}/status`, { status: 'rejected' });
  assert.equal((await apply()).status, 201);
});

test('admin: list with counts and filters, detail, status, notes, CSV, and the fee in Transactions', async () => {
  assert.equal((await srv.request('GET', '/api/admin/partner-applications')).status, 401);
  const paid = await submitted({ category: 'other', otherCategory: 'Mobile shop' });
  await apply({ businessName: 'Fresh Mart', category: 'grocery', phone: '9876500009', city: 'Bhopal' }); // unpaid

  const list = await admin$('GET', '/');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 2);
  assert.equal(list.body.data.counts.new, 1);
  assert.equal(list.body.data.counts.pending_payment, 1);
  const row = list.body.data.applications.find((r) => r._id === paid.id);
  assert.equal(row.categoryLabel, 'Other — Mobile shop');
  assert.equal(row.paid, true);
  assert.equal((await admin$('GET', '/?category=grocery')).body.data.total, 1);
  assert.equal((await admin$('GET', '/?q=Fresh')).body.data.total, 1);
  assert.equal((await admin$('GET', '/?city=bho')).body.data.total, 1);

  const detail = (await admin$('GET', `/${paid.id}`)).body.data.application;
  assert.equal(detail.address, VALID.address);
  assert.equal(detail.questions, VALID.questions);

  const moved = await admin$('PATCH', `/${paid.id}/status`, { status: 'contacted', note: 'Called, visiting Monday' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.data.application.status, 'contacted');
  assert.equal(moved.body.data.application.notes[0].text, 'Called, visiting Monday');
  const unpaidId = list.body.data.applications.find((r) => !r.paid)._id;
  assert.equal((await admin$('PATCH', `/${unpaidId}/status`, { status: 'contacted' })).status, 409, 'unpaid ones are not reviewed');
  assert.equal((await admin$('POST', `/${paid.id}/notes`, { text: 'Owner wants a demo' })).status, 201);

  const csv = await fetch(`${srv.base}/api/admin/partner-applications/export.csv`, { headers: adminHeaders });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Business Name/);
  assert.match(text, /Glow Unisex Salon/);

  const tx = await srv.request('GET', '/api/admin/transactions?kind=partner_fee', { headers: adminHeaders });
  assert.equal(tx.status, 200, JSON.stringify(tx.body));
  const rows = tx.body.data.transactions ?? tx.body.data.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amountPaise, 10_000);
  assert.equal(rows[0].party.name, 'Glow Unisex Salon');
  assert.equal(rows[0].link, `/partner-applications/${paid.id}`);
});
