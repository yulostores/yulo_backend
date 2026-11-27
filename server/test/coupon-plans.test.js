// CB4 — coupon partner plans: the plan list, Razorpay purchase (order, verify, webhook — each
// idempotent, amount checked), activation (stock + complimentary coupons), admin "Amount Received",
// the plan editor, and the stock primitives takeOne / giveBack under concurrency. Fake Razorpay,
// in-memory MongoDB, in-memory Redis stand-in.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  webhookSignature,
  paymentCapturedEvent,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller, sellerHeaders } = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const subs = await import('../services/sellerSubscription.service.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponPlan } = await import('../models/CouponPlan.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: User } = await import('../models/User.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');

const redis = fakeRedis();
let mongo;
let srv;
let fake;
let category;
let admin;
let adminHeaders;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([SellerSubscription.init(), Coupon.init(), CouponPlan.init(), StrayPayment.init(), WebhookEvent.init()]);
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  __setRazorpayForTests(undefined);
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  __resetCouponSettingsCache();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  await seedCouponData({ apply: true, log: () => {} });
  category = await makeCategory({ key: 'salon-x', name: 'Salon' });
  admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
});

// Offline ("Amount Received"): plan price + 18 % GST.
const TOTALS = { basic: 590_000, plus: 1_770_000, premium: 5_900_000 };
// Online (Razorpay): price + 3.5 % payment handling fee, then 18 % GST on both.
const ONLINE_TOTALS = { basic: 610_650, plus: 1_831_950, premium: 6_106_500 };
const ALLOCATION = { basic: 250, plus: 900, premium: 4_000 };

const seller = (over = {}) => makeCompleteSeller({ status: 'active', categoryId: category._id, ...over });
const call = (method, path, body, headers) => srv.request(method, `/api/seller${path}`, { body, headers });
const admin$ = (method, path, body, headers = adminHeaders) => srv.request(method, `/api/admin${path}`, { body, headers });

let payN = 0;
// A captured Razorpay payment for a Razorpay order, as Razorpay would hold it.
const pay = (orderId, amount, over = {}) => fake.addPayment({ id: `pay_test_${(payN += 1)}`, order_id: orderId, amount, ...over });

const buy = async (headers, planKey = 'basic') => {
  const res = await call('POST', '/subscriptions', { planKey }, headers);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const verify = (headers, subscriptionId, orderId, paymentId, signature) =>
  call('POST', `/subscriptions/${subscriptionId}/verify`, {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature ?? checkoutSignature(orderId, paymentId),
  }, headers);

const deliverWebhook = (payment, { type = 'payment.captured', eventId } = {}) => {
  const raw = JSON.stringify(paymentCapturedEvent(payment, type));
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': eventId ?? `evt_${Math.random()}` },
  });
};

const complimentaryOf = (subscriptionId) => Coupon.countDocuments({ subscriptionId, kind: 'complimentary' });
const noComplimentaryIn = (body, label) => assert.ok(!/complimentary/i.test(JSON.stringify(body)), `${label} mentions complimentary coupons`);

// ── Plans ─────────────────────────────────────────────────────────────────────

test('the plan list: base, GST and total for each plan, cheapest first, without complimentary counts', async () => {
  const { headers } = await seller();
  const res = await call('GET', '/plans', undefined, headers);
  assert.equal(res.status, 200);
  const plans = res.body.data.plans;
  assert.deepEqual(plans.map((p) => p.key), ['basic', 'plus', 'premium']);
  assert.deepEqual(plans.map((p) => p.price), [
    { base: 5000, gst: 900, total: 5900 },
    { base: 15000, gst: 2700, total: 17700 },
    { base: 50000, gst: 9000, total: 59000 },
  ]);
  assert.deepEqual(plans.map((p) => p.couponAllocation), [250, 900, 4000]);
  noComplimentaryIn(res.body, 'GET /plans');
});

test('plan routes: the owner only — managers, employees and unapproved sellers are refused', async () => {
  const { seller: s } = await seller();
  const manager = await SellerUser.create({ sellerId: s._id, name: 'M', phone: '9111111111', role: 'manager' });
  const employee = await SellerUser.create({ sellerId: s._id, name: 'E', phone: '9222222222', role: 'employee' });
  for (const [method, path, body] of [['GET', '/plans'], ['GET', '/subscriptions'], ['POST', '/subscriptions', { planKey: 'basic' }]]) {
    assert.equal((await call(method, path, body, sellerHeaders(manager))).status, 403, `manager ${method} ${path}`);
  }
  for (const [method, path, body] of [['GET', '/plans'], ['GET', '/subscriptions'], ['POST', '/subscriptions', { planKey: 'basic' }]]) {
    assert.equal((await call(method, path, body, sellerHeaders(employee))).status, 403, `employee ${method} ${path}`);
    assert.equal((await call(method, path, body, {})).status, 401, `no token ${method} ${path}`);
  }
  const pending = await makeCompleteSeller({ status: 'pending', categoryId: category._id, phone: '9000000002' });
  const res = await call('GET', '/plans', undefined, pending.headers);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SELLER_NOT_ACTIVE');
});

// ── Razorpay purchase ─────────────────────────────────────────────────────────

test('buying creates a pending subscription and a Razorpay order for the GST-inclusive total', async () => {
  const { headers, seller: s } = await seller();
  const data = await buy(headers, 'plus');
  assert.equal(data.subscription.status, 'pending_payment');
  assert.equal(data.subscription.remaining, 0);
  assert.equal(data.razorpayOrder.amount, ONLINE_TOTALS.plus);
  assert.equal(data.razorpayOrder.keyId, 'rzp_test_fake');
  const [created] = fake.calls.ordersCreate;
  assert.equal(created.amount, ONLINE_TOTALS.plus);
  assert.equal(created.notes.kind, 'seller_subscription');
  assert.equal(created.notes.subscriptionId, String(data.subscription._id));
  const stored = await SellerSubscription.findById(data.subscription._id).lean();
  assert.equal(stored.payment.razorpayOrderId, data.razorpayOrder.id);
  assert.equal(String(stored.sellerId), String(s._id));
  noComplimentaryIn(data, 'POST /subscriptions');
});

test('buying refuses an unknown or withdrawn plan and bad input', async () => {
  const { headers } = await seller();
  assert.equal((await call('POST', '/subscriptions', { planKey: 'gold' }, headers)).status, 404);
  await CouponPlan.updateOne({ key: 'plus' }, { isActive: false });
  assert.equal((await call('POST', '/subscriptions', { planKey: 'plus' }, headers)).status, 404);
  assert.equal((await call('POST', '/subscriptions', {}, headers)).status, 400);
  assert.equal((await call('POST', '/subscriptions', { planKey: 'basic', amount: 1 }, headers)).status, 400);
  assert.equal(await SellerSubscription.countDocuments(), 0);
});

test('a gateway failure while creating the order leaves no pending subscription behind', async () => {
  const { headers } = await seller();
  fake.orders.create = async () => {
    throw { statusCode: 500, error: { description: 'down' } };
  };
  const res = await call('POST', '/subscriptions', { planKey: 'basic' }, headers);
  assert.equal(res.status, 502);
  assert.equal(await SellerSubscription.countDocuments(), 0);
});

test('verify activates: stock = the plan\'s coupons, plus exactly 5 complimentary; a second verify is a no-op', async () => {
  const { headers } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const payment = pay(razorpayOrder.id, ONLINE_TOTALS.basic);

  const res = await verify(headers, subscription._id, razorpayOrder.id, payment.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body.data.subscription;
  assert.equal(s.status, 'active');
  assert.deepEqual([s.allocated, s.issued, s.remaining], [250, 0, 250]);
  assert.equal(s.paidPaise, ONLINE_TOTALS.basic);
  noComplimentaryIn(res.body, 'verify');

  assert.equal(await complimentaryOf(subscription._id), 5);
  const comp = await Coupon.find({ subscriptionId: subscription._id }).lean();
  assert.ok(comp.every((c) => c.kind === 'complimentary' && c.status === 'issued' && !c.customerId && c.source.type === 'plan'));
  assert.equal(new Set(comp.map((c) => c.code)).size, 5);

  const again = await verify(headers, subscription._id, razorpayOrder.id, payment.id);
  assert.equal(again.status, 200);
  assert.equal(await complimentaryOf(subscription._id), 5);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).remaining, 250);
});

test('verify refuses a bad signature, another order\'s payment, and another seller\'s purchase', async () => {
  const { headers } = await seller();
  const other = await seller({ phone: '9000000003' });
  const { subscription, razorpayOrder } = await buy(headers);
  const payment = pay(razorpayOrder.id, ONLINE_TOTALS.basic);

  assert.equal((await verify(headers, subscription._id, razorpayOrder.id, payment.id, 'f'.repeat(64))).status, 400);
  assert.equal((await verify(headers, subscription._id, 'order_other', payment.id)).status, 400);
  assert.equal((await verify(other.headers, subscription._id, razorpayOrder.id, payment.id)).status, 404);
  assert.equal((await call('POST', `/subscriptions/${subscription._id}/verify`, { razorpay_order_id: 'x' }, headers)).status, 400);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).status, 'pending_payment');
  assert.equal(await complimentaryOf(subscription._id), 0);
});

test('a payment for the wrong amount is not activated and is recorded as owed back', async () => {
  const { headers, seller: s } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const short = pay(razorpayOrder.id, 100_00);

  const res = await verify(headers, subscription._id, razorpayOrder.id, short.id);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PAYMENT_VERIFICATION_FAILED');
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).status, 'pending_payment');
  const stray = await StrayPayment.findOne({ razorpayPaymentId: short.id }).lean();
  assert.equal(stray.kind, 'seller_payment_refused');
  assert.equal(String(stray.sellerId), String(s._id));
  assert.equal(stray.refund.status, 'pending');

  // The webhook for the same payment changes nothing and records nothing twice.
  await deliverWebhook(short);
  assert.equal(await StrayPayment.countDocuments({ razorpayPaymentId: short.id }), 1);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).status, 'pending_payment');
});

test('the webhook activates once, whether delivered twice, as two events, or alongside verify', async () => {
  const { headers } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const payment = pay(razorpayOrder.id, ONLINE_TOTALS.basic);

  assert.equal((await deliverWebhook(payment, { eventId: 'evt_same' })).status, 200);
  assert.equal((await deliverWebhook(payment, { eventId: 'evt_same' })).status, 200);
  assert.equal((await deliverWebhook(payment, { type: 'order.paid' })).status, 200);
  assert.equal((await verify(headers, subscription._id, razorpayOrder.id, payment.id)).status, 200);

  const stored = await SellerSubscription.findById(subscription._id).lean();
  assert.equal(stored.status, 'active');
  assert.equal(stored.payment.razorpayPaymentId, payment.id);
  assert.equal(stored.remaining, 250);
  assert.equal(await complimentaryOf(subscription._id), 5);
  assert.equal(await StrayPayment.countDocuments(), 0);
});

test('verify and the webhook racing each other activate once', async () => {
  const { headers } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const payment = pay(razorpayOrder.id, ONLINE_TOTALS.basic);
  const results = await Promise.all([
    verify(headers, subscription._id, razorpayOrder.id, payment.id),
    deliverWebhook(payment),
    deliverWebhook(payment, { type: 'order.paid' }),
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(await complimentaryOf(subscription._id), 5);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).remaining, 250);
});

test('a second payment for an already-paid plan is owed back, not counted', async () => {
  const { headers } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const first = pay(razorpayOrder.id, ONLINE_TOTALS.basic);
  const second = pay(razorpayOrder.id, ONLINE_TOTALS.basic);
  await verify(headers, subscription._id, razorpayOrder.id, first.id);

  await deliverWebhook(second);
  const stray = await StrayPayment.findOne({ razorpayPaymentId: second.id }).lean();
  assert.equal(stray.kind, 'seller_duplicate_payment');
  const dup = await verify(headers, subscription._id, razorpayOrder.id, second.id);
  assert.equal(dup.status, 409);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).payment.razorpayPaymentId, first.id);
});

test('a payment.failed event for a plan purchase changes nothing', async () => {
  const { headers } = await seller();
  const { subscription, razorpayOrder } = await buy(headers);
  const failed = pay(razorpayOrder.id, ONLINE_TOTALS.basic, { status: 'failed' });
  assert.equal((await deliverWebhook(failed, { type: 'payment.failed' })).status, 200);
  assert.equal((await SellerSubscription.findById(subscription._id).lean()).status, 'pending_payment');
});

test('simulated payment is off unless local simulation is enabled', async () => {
  const { headers } = await seller();
  const { subscription } = await buy(headers);
  assert.equal((await call('POST', `/subscriptions/${subscription._id}/simulate-payment`, undefined, headers)).status, 404);
});

// ── Amount Received ───────────────────────────────────────────────────────────

const manual = (over = {}) => ({
  planKey: 'basic',
  amountRupees: 5900,
  mode: 'neft',
  reference: 'UTR123456789',
  receivedOn: new Date().toISOString(),
  ...over,
});

test('Amount Received activates each plan with its stock and 5 complimentary coupons, and is audit-logged', async () => {
  const { seller: s, headers } = await seller();
  for (const [i, planKey] of ['basic', 'plus', 'premium'].entries()) {
    const res = await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual({ planKey, amountRupees: TOTALS[planKey] / 100, reference: `UTR-${i}` }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sub = res.body.data.subscription;
    assert.equal(sub.status, 'active');
    assert.equal(sub.allocated, ALLOCATION[planKey]);
    assert.equal(sub.remaining, ALLOCATION[planKey]);
    assert.equal(sub.payment.method, 'manual');
    assert.equal(String(sub.payment.manual.recordedBy), String(admin._id));
    assert.equal(await complimentaryOf(sub._id), 5);
  }
  const logs = await AdminActivityLog.find({ action: 'SELLER_PLAN_PAYMENT_RECORDED', targetId: s._id }).lean();
  assert.equal(logs.length, 3);
  assert.equal(logs[0].metadata.reference, 'UTR-0');

  // The seller sees the stock across all three, without complimentary counts.
  const mine = await call('GET', '/subscriptions', undefined, headers);
  assert.deepEqual(mine.body.data.stock, { allocated: 5150, issued: 0, remaining: 5150 });
  assert.equal(mine.body.data.currentPlan.plan.key, 'basic', 'the oldest active plan is drawn first');
  noComplimentaryIn(mine.body, 'GET /subscriptions');
});

test('Amount Received: a different amount needs a reason; with one it is accepted and recorded', async () => {
  const { seller: s } = await seller();
  const short = await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual({ amountRupees: 5000 }));
  assert.equal(short.status, 422);
  assert.equal(short.body.code, 'AMOUNT_MISMATCH');
  assert.deepEqual([short.body.details.expectedPaise, short.body.details.receivedPaise], [590_000, 500_000]);
  assert.equal(await SellerSubscription.countDocuments(), 0);

  const ok = await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual({ amountRupees: 5000, overrideReason: 'Launch discount agreed by sales' }));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.subscription.payment.amountPaise, 500_000);
  assert.equal(ok.body.data.subscription.payment.manual.overrideReason, 'Launch discount agreed by sales');
});

test('Amount Received: the same reference cannot be recorded twice, even at once', async () => {
  const { seller: s } = await seller();
  const results = await Promise.all([
    admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual()),
    admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual()),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await SellerSubscription.countDocuments(), 1);
  assert.equal(await Coupon.countDocuments({ kind: 'complimentary' }), 5);
});

test('Amount Received: refused for an unapproved seller, bad input, and anyone but an admin', async () => {
  const pending = await makeCompleteSeller({ status: 'pending', categoryId: category._id, phone: '9000000004' });
  const r = await admin$('POST', `/sellers/${pending.seller._id}/subscriptions/manual`, manual());
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SELLER_NOT_ACTIVE');

  const { seller: s, headers } = await seller();
  for (const bad of [{ mode: 'barter' }, { reference: '' }, { amountRupees: -5 }, { receivedOn: '2999-01-01' }, { planKey: 'gold' }, { extra: 1 }]) {
    const res = await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual(bad));
    assert.ok([400, 404].includes(res.status), JSON.stringify(bad));
  }
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  const asCustomer = { authorization: `Bearer ${auth.generateTokens(customer._id, 'customer').accessToken}` };
  assert.equal((await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual(), asCustomer)).status, 403);
  assert.equal((await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual(), headers)).status, 401, 'a seller session');
  assert.equal(await SellerSubscription.countDocuments(), 0);
});

test('the admin subscription list shows the complimentary coupons per purchase', async () => {
  const { seller: s } = await seller();
  await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual());
  const res = await admin$('GET', `/sellers/${s._id}/subscriptions`);
  assert.equal(res.status, 200);
  const [sub] = res.body.data.subscriptions;
  assert.equal(sub.plan.complimentaryCount, 5);
  assert.deepEqual(sub.complimentary, { total: 5, issued: 5, redeemed: 0, expired: 0, void: 0 });
  assert.equal((await admin$('GET', `/sellers/${new mongoose.Types.ObjectId()}/subscriptions`)).status, 404);
});

// ── Plan editor ───────────────────────────────────────────────────────────────

test('editing a plan changes new purchases only, and is audit-logged', async () => {
  const { seller: s, headers } = await seller();
  await admin$('POST', `/sellers/${s._id}/subscriptions/manual`, manual());

  const list = await admin$('GET', '/coupon-plans');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.plans.length, 3);
  assert.equal(list.body.data.plans[0].complimentaryCount, 5);

  const res = await admin$('PUT', '/coupon-plans/basic', { basePriceRupees: 4500, couponAllocation: 300 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.plan.price, { base: 4500, gst: 810, total: 5310 });

  const old = await SellerSubscription.findOne({ sellerId: s._id }).lean();
  assert.equal(old.planSnapshot.totalPaise, 590_000, 'the existing purchase keeps its price');
  assert.equal(old.allocated, 250);

  const { razorpayOrder } = await buy(headers);
  assert.equal(razorpayOrder.amount, 549_585, 'a new online purchase pays the new price + 3.5 % fee + GST');

  const [log] = await AdminActivityLog.find({ action: 'COUPON_PLAN_UPDATED' }).lean();
  assert.deepEqual(log.metadata.changes.map((c) => c.field).sort(), ['basePricePaise', 'couponAllocation']);
});

test('the plan editor validates and is admin-only', async () => {
  for (const bad of [{}, { basePriceRupees: -1 }, { couponAllocation: 2.5 }, { gstPercent: 40 }, { key: 'x' }]) {
    assert.equal((await admin$('PUT', '/coupon-plans/basic', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin$('PUT', '/coupon-plans/gold', { name: 'Gold' })).status, 404);
  const { headers } = await seller();
  assert.equal((await admin$('GET', '/coupon-plans', undefined, headers)).status, 401);
});

// ── Stock primitives ──────────────────────────────────────────────────────────

const activeSub = async (sellerId, remaining, activatedAt = new Date()) => {
  const doc = await SellerSubscription.create({
    sellerId,
    planSnapshot: { planId: new mongoose.Types.ObjectId(), key: 'basic', name: 'Basic', basePricePaise: 500_000, gstPercent: 18, gstPaise: 90_000, totalPaise: 590_000, couponAllocation: remaining, complimentaryCount: 5 },
    payment: { method: 'manual' },
    status: 'active',
    allocated: remaining,
    remaining,
    activatedAt,
  });
  return doc._id;
};

test('takeOne: 50 parallel takes against 10 coupons of stock → exactly 10 succeed, then exhausted', async () => {
  const { seller: s } = await seller();
  const id = await activeSub(s._id, 10);
  const results = await Promise.all(Array.from({ length: 50 }, () => subs.takeOne(s._id)));
  assert.equal(results.filter(Boolean).length, 10);
  const after = await SellerSubscription.findById(id).lean();
  assert.deepEqual([after.remaining, after.issued, after.status], [0, 10, 'exhausted']);
  assert.ok(after.exhaustedAt);
  assert.equal(await subs.takeOne(s._id), null);
});

test('takeOne draws the oldest active subscription first; giveBack returns stock and reopens it', async () => {
  const { seller: s } = await seller();
  const newer = await activeSub(s._id, 5, new Date('2026-11-10'));
  const older = await activeSub(s._id, 2, new Date('2026-11-01'));
  const drawn = [];
  for (let i = 0; i < 3; i += 1) drawn.push(String((await subs.takeOne(s._id))._id));
  assert.deepEqual(drawn, [String(older), String(older), String(newer)]);
  assert.equal((await SellerSubscription.findById(older).lean()).status, 'exhausted');

  const back = await subs.giveBack(older);
  assert.deepEqual([back.status, back.remaining, back.issued, back.exhaustedAt], ['active', 1, 1, null]);
  assert.equal(String((await subs.takeOne(s._id))._id), String(older), 'returned stock is drawn first again');

  // Nothing issued → nothing to give back; another seller's stock is never touched.
  const fresh = await activeSub(s._id, 3);
  assert.equal(await subs.giveBack(fresh), null);
  const other = await seller({ phone: '9000000005' });
  assert.equal(await subs.takeOne(other.seller._id), null);
});

test('activate is idempotent and refuses a cancelled subscription', async () => {
  const { seller: s } = await seller();
  const sub = await SellerSubscription.create({
    sellerId: s._id,
    planSnapshot: { planId: new mongoose.Types.ObjectId(), key: 'basic', name: 'Basic', basePricePaise: 500_000, gstPercent: 18, gstPaise: 90_000, totalPaise: 590_000, couponAllocation: 250, complimentaryCount: 5 },
    payment: { method: 'manual' },
  });
  const [a, b] = await Promise.all([subs.activate(sub._id), subs.activate(sub._id)]);
  assert.deepEqual([a.activatedNow, b.activatedNow].sort(), [false, true]);
  assert.equal(await complimentaryOf(sub._id), 5);

  const cancelled = await SellerSubscription.create({
    sellerId: s._id,
    planSnapshot: sub.planSnapshot,
    payment: { method: 'manual' },
    status: 'cancelled',
  });
  await assert.rejects(subs.activate(cancelled._id), (err) => err.code === 'INVALID_STATE');
});
