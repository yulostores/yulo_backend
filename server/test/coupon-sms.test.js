// CB10 — SMS credits and reminder campaigns through HTTP: the credit shop (₹3.54 per SMS),
// buying a pack through a stubbed Razorpay (verify + webhook, idempotent, wrong amounts and second
// payments owed back), the admin's "Amount Received" for credits, admin campaign preview / create /
// list / detail (cost = count × 354 paise, phones masked), the seller's reminder screen (no phone
// digits at all), and the mock provider never logging a full number. Nothing is ever sent.

import test, { after, before, beforeEach, mock } from 'node:test';
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
const { makeCategory, makeCompleteSeller, sellerHeaders, assertSellerSafe } = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const auth = await import('../services/auth.service.js');
const sms = await import('../services/sms/templateSender.js');
const { runCouponTick } = await import('../jobs/couponScheduler.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { default: logger } = await import('../utils/logger.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: User } = await import('../models/User.js');
const { default: SmsCreditPurchase } = await import('../models/SmsCreditPurchase.js');
const { default: SmsCampaign } = await import('../models/SmsCampaign.js');
const { default: SmsLog } = await import('../models/SmsLog.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');

const redis = fakeRedis();
let mongo;
let srv;
let fake;
let category;
let shop;
let adminHeaders;
let customers;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Coupon.init(), SmsCreditPurchase.init(), SmsLog.init(), SmsCampaign.init(), StrayPayment.init(), WebhookEvent.init()]);
  auth.__setAuthRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  __setRazorpayForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  __resetCouponSettingsCache();
  sms.__clearMockOutbox();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  category = await makeCategory({ key: 'salon', name: 'Salon', enabled: true });
  shop = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000001' });
  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  customers = await User.create(
    Array.from({ length: 5 }, (_, i) => ({ name: `${['Priya', 'Rahul', 'Anita', 'Kiran', 'Vikram'][i]} Shah`, phone: `98111000${String(i + 1).padStart(2, '0')}`, role: 'customer' }))
  );
});

const seller = (method, path, body, headers = shop.headers) => srv.request(method, `/api/seller${path}`, { body, headers });
const admin = (method, path, body, headers = adminHeaders) => srv.request(method, `/api/admin${path}`, { body, headers });
const balance = async () => (await Seller.findById(shop.seller._id).lean()).smsCreditsBalance;
const webhook = (payment, eventId) => {
  const raw = JSON.stringify(paymentCapturedEvent(payment));
  return srv.request('POST', '/api/webhooks/razorpay', { raw, headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': eventId } });
};

const DAY = 86_400_000;
const coupon = (customer, expiresInMs, over = {}) =>
  Coupon.create({
    code: generateCouponCode(),
    kind: 'customer',
    sellerId: shop.seller._id,
    subscriptionId: new mongoose.Types.ObjectId(),
    categoryId: category._id,
    customerId: customer._id,
    customerSnapshot: { name: customer.name },
    offerSnapshot: { title: '20% off', terms: '' },
    source: { type: 'order', id: new mongoose.Types.ObjectId() },
    expiresAt: new Date(Date.now() + expiresInMs),
    ...over,
  });

// ── Credit shop ───────────────────────────────────────────────────────────────

test('the credit shop: ₹3.54 per SMS, packs priced from settings, empty balance', async () => {
  const res = await seller('GET', '/sms-credits');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.balance, 0);
  assert.deepEqual(d.perSms, { pricePaise: 300, gstPaise: 54, totalPaise: 354, total: 3.54, gstPercent: 18 });
  assert.deepEqual(d.packs, [
    { credits: 100, pricePaise: 30_000, gstPaise: 5_400, totalPaise: 35_400, total: 354 },
    { credits: 500, pricePaise: 150_000, gstPaise: 27_000, totalPaise: 177_000, total: 1770 },
    { credits: 1000, pricePaise: 300_000, gstPaise: 54_000, totalPaise: 354_000, total: 3540 },
  ]);
  assert.equal(d.available, true);
  const employee = await SellerUser.create({ sellerId: shop.seller._id, name: 'Ravi', phone: '9700000002', role: 'employee' });
  assert.equal((await seller('GET', '/sms-credits', undefined, sellerHeaders(employee))).status, 403);
  assert.equal((await seller('POST', '/sms-credits/purchase', { credits: 100 }, sellerHeaders(employee))).status, 403);
});

test('buying a pack: Razorpay order (notes.kind sms_credits) → verify adds the credits; the webhook again changes nothing', async () => {
  assert.equal((await seller('POST', '/sms-credits/purchase', { credits: 250 })).status, 400, 'not a pack');
  const started = await seller('POST', '/sms-credits/purchase', { credits: 100 });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { purchase, razorpayOrder } = started.body.data;
  assert.equal(razorpayOrder.amount, 35_400);
  assert.equal(fake.calls.ordersCreate[0].notes.kind, 'sms_credits');
  assert.equal(fake.calls.ordersCreate[0].amount, 35_400);
  assert.equal(purchase.status, 'pending_payment');

  const payment = fake.addPayment({ id: 'pay_sms_1', order_id: razorpayOrder.id, amount: 35_400 });
  const verify = await seller('POST', `/sms-credits/purchase/${purchase._id}/verify`, {
    razorpay_order_id: razorpayOrder.id,
    razorpay_payment_id: 'pay_sms_1',
    razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_sms_1'),
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.data.purchase.status, 'paid');
  assert.equal(await balance(), 100);

  // The webhook for the same payment, twice, and verify again: still 100.
  await webhook(payment, 'evt_sms_1');
  await webhook(payment, 'evt_sms_1b');
  await seller('POST', `/sms-credits/purchase/${purchase._id}/verify`, {
    razorpay_order_id: razorpayOrder.id,
    razorpay_payment_id: 'pay_sms_1',
    razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_sms_1'),
  });
  assert.equal(await balance(), 100);
  assert.equal((await seller('GET', '/sms-credits')).body.data.purchases[0].status, 'paid');

  const forged = await seller('POST', `/sms-credits/purchase/${purchase._id}/verify`, {
    razorpay_order_id: razorpayOrder.id,
    razorpay_payment_id: 'pay_sms_x',
    razorpay_signature: 'f'.repeat(64),
  });
  assert.equal(forged.status, 400);
});

test('webhook first, parallel confirmations, a second payment and a wrong amount: credited once, the rest owed back', async () => {
  const { purchase, razorpayOrder } = (await seller('POST', '/sms-credits/purchase', { credits: 500 })).body.data;
  const payment = fake.addPayment({ id: 'pay_sms_2', order_id: razorpayOrder.id, amount: 177_000 });
  await Promise.all([
    webhook(payment, 'evt_a'),
    webhook(payment, 'evt_b'),
    seller('POST', `/sms-credits/purchase/${purchase._id}/verify`, {
      razorpay_order_id: razorpayOrder.id,
      razorpay_payment_id: 'pay_sms_2',
      razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_sms_2'),
    }),
  ]);
  assert.equal(await balance(), 500);

  const second = fake.addPayment({ id: 'pay_sms_3', order_id: razorpayOrder.id, amount: 177_000 });
  await webhook(second, 'evt_c');
  assert.equal(await balance(), 500);
  assert.ok(await StrayPayment.exists({ razorpayPaymentId: 'pay_sms_3', kind: 'sms_credits_duplicate_payment', smsCreditPurchaseId: purchase._id }));

  const other = (await seller('POST', '/sms-credits/purchase', { credits: 100 })).body.data;
  const wrong = fake.addPayment({ id: 'pay_sms_4', order_id: other.razorpayOrder.id, amount: 100 });
  await webhook(wrong, 'evt_d');
  assert.equal(await balance(), 500, 'a wrong amount adds nothing');
  assert.equal((await SmsCreditPurchase.findById(other.purchase._id).lean()).status, 'pending_payment');
  assert.ok(await StrayPayment.exists({ razorpayPaymentId: 'pay_sms_4', kind: 'sms_credits_payment_refused' }));
});

test('admin "Amount Received" for credits: priced at ₹3.54 each, audit-logged, one entry per reference', async () => {
  const body = { credits: 50, amountRupees: 177, mode: 'upi', reference: 'UPI-778899', receivedOn: '2026-11-10' };
  const res = await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.balance, 50);
  assert.equal(res.body.data.purchase.method, 'manual');
  const log = await AdminActivityLog.findOne({ action: 'SELLER_SMS_CREDITS_RECORDED' }).lean();
  assert.equal(log.metadata.credits, 50);
  assert.equal(log.metadata.amountPaise, 17_700);

  assert.equal((await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, body)).body.code, 'DUPLICATE_PAYMENT');
  const mismatch = await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, { ...body, reference: 'UPI-2', amountRupees: 150 });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.details.expectedPaise, 17_700);
  const discounted = await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, { ...body, reference: 'UPI-3', amountRupees: 150, overrideReason: 'Launch discount' });
  assert.equal(discounted.status, 201);
  assert.equal(await balance(), 100);
  assert.equal((await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, { ...body, reference: 'UPI-4', credits: 0 })).status, 400);
  const customer = { authorization: `Bearer ${auth.generateTokens(customers[0]._id, 'customer').accessToken}` };
  assert.equal((await admin('POST', `/sellers/${shop.seller._id}/sms-credits/manual`, { ...body, reference: 'UPI-5' }, customer)).status, 403);
});

// ── Admin campaigns ───────────────────────────────────────────────────────────

test('campaign preview: recipients with a phone, cost = count × 354 paise; filters narrow it', async () => {
  const other = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000002' });
  for (let i = 0; i < 3; i += 1) await coupon(customers[i], DAY);
  await coupon(customers[3], DAY, { sellerId: other.seller._id });
  await coupon(customers[4], 20 * DAY); // outside the default window (3 days)
  await coupon(customers[4], DAY, { status: 'redeemed' });
  const noPhone = await User.create({ name: 'No Phone', role: 'customer' });
  await coupon(noPhone, DAY);

  const all = await admin('POST', '/reminder-campaigns/preview', {});
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.data.recipientCount, 4);
  assert.deepEqual(all.body.data.cost, { pricePaise: 1200, gstPaise: 216, totalPaise: 1416, total: 14.16 });
  assert.equal(all.body.data.cost.totalPaise, 4 * 354);
  assert.equal(all.body.data.perSms.totalPaise, 354);

  const one = (await admin('POST', '/reminder-campaigns/preview', { seller: String(other.seller._id) })).body.data;
  assert.equal(one.recipientCount, 1);
  assert.equal(one.cost.totalPaise, 354);
  const wide = (await admin('POST', '/reminder-campaigns/preview', { expiringTo: new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10) })).body.data;
  assert.equal(wide.recipientCount, 5);
  assert.equal(wide.cost.totalPaise, 5 * 354);
  for (const body of [{ seller: 'x' }, { expiringFrom: '2026-12-10', expiringTo: '2026-12-01' }, { bogus: 1 }]) {
    assert.equal((await admin('POST', '/reminder-campaigns/preview', body)).status, 400, JSON.stringify(body));
  }
});

test('campaign create → queued, sent at the next run; list and detail with masked phones; admin only', async () => {
  for (let i = 0; i < 2; i += 1) await coupon(customers[i], DAY);
  const created = await admin('POST', '/reminder-campaigns', { seller: String(shop.seller._id) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const c = created.body.data.campaign;
  assert.equal(c.status, 'queued');
  assert.equal(c.recipientCount, 2);
  assert.equal(c.cost.totalPaise, 708);
  assert.ok(await AdminActivityLog.exists({ action: 'REMINDER_CAMPAIGN_QUEUED', targetId: c._id }));
  assert.equal((await admin('POST', '/reminder-campaigns', { seller: String(new mongoose.Types.ObjectId()) })).body.code, 'NO_RECIPIENTS');

  // The next 10:00 IST run (today, whatever the real clock says).
  const tenIst = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T04:40:00Z`);
  await runCouponTick({ now: new Date(Math.max(tenIst.getTime(), Date.now())), redis: fakeRedis() });

  const list = (await admin('GET', '/reminder-campaigns?type=admin')).body.data;
  assert.equal(list.total, 1);
  assert.equal(list.campaigns[0].status, 'done');
  const detail = (await admin('GET', `/reminder-campaigns/${c._id}`)).body.data;
  assert.deepEqual(detail.campaign.counts, { sent: 2, failed: 0 });
  assert.deepEqual(detail.logCounts, { queued: 0, sent: 2, failed: 0 });
  assert.deepEqual(detail.log.map((l) => l.phone).sort(), ['******0001', '******0002']);
  assert.ok(!JSON.stringify(detail).match(/98111000\d\d/), 'no full phone');
  assert.equal((await admin('GET', `/reminder-campaigns/${new mongoose.Types.ObjectId()}`)).status, 404);

  const customer = { authorization: `Bearer ${auth.generateTokens(customers[0]._id, 'customer').accessToken}` };
  for (const [method, path, body] of [['POST', '/reminder-campaigns/preview', {}], ['POST', '/reminder-campaigns', {}], ['GET', '/reminder-campaigns'], ['GET', `/reminder-campaigns/${c._id}`]]) {
    assert.equal((await admin(method, path, body, customer)).status, 403, `${method} ${path}`);
  }
});

// ── Seller reminder screen ────────────────────────────────────────────────────

test("the seller's reminder screen: expiring coupons (masked, reminded or not), credits, their own sent log — no phone digits", async () => {
  await Seller.updateOne({ _id: shop.seller._id }, { $set: { smsCreditsBalance: 1 } });
  const a = await coupon(customers[0], DAY);
  await coupon(customers[1], 2 * DAY);
  await coupon(customers[2], 10 * DAY); // not expiring soon
  const tenIst = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T04:40:00Z`);
  await runCouponTick({ now: new Date(Math.max(tenIst.getTime(), Date.now())), redis: fakeRedis() });

  const res = await seller('GET', '/reminders');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.credits, 0, 'one credit, one SMS (the soonest)');
  assert.equal(d.reminderLeadDays, 3);
  assert.equal(d.expiringSoon.length, 2);
  assert.equal(d.expiringSoon[0].id, String(a._id));
  assert.equal(d.expiringSoon[0].reminded, true);
  assert.equal(d.expiringSoon[1].reminded, false);
  assert.equal(d.expiringSoon[0].customerName, 'Priya S.');
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].status, 'sent');
  assertSellerSafe(res.body, { customerPhones: customers.map((c) => c.phone), customerIds: customers.map((c) => String(c._id)), label: 'reminders' });
  assert.ok(!/\*{4,}\d{4}/.test(JSON.stringify(res.body)), 'not even a masked number');
});

// ── The mock provider ─────────────────────────────────────────────────────────

test('the mock provider sends nothing and never logs a full phone number', async () => {
  const lines = [];
  const capture = (...args) => lines.push(JSON.stringify(args));
  const spies = ['info', 'warn', 'error', 'debug'].map((level) => mock.method(logger, level, capture));
  try {
    const result = await sms.sendTemplate('9811100009', 'coupon_expiry_reminder', { business: 'Glow Salon', expiry: '22 Nov 2026' });
    assert.equal(result.provider, 'mock');
    sms.__setSendOverrideForTests(async () => {
      throw Object.assign(new Error('rejected'), { code: 'X' });
    });
    await Seller.updateOne({ _id: shop.seller._id }, { $set: { smsCreditsBalance: 2 } });
    await coupon({ _id: customers[0]._id, name: 'P' }, DAY);
    const tenIst = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T04:40:00Z`);
    await runCouponTick({ now: new Date(Math.max(tenIst.getTime(), Date.now())), redis: fakeRedis() });
  } finally {
    sms.__setSendOverrideForTests(null);
    for (const s of spies) s.mock.restore();
  }
  assert.ok(lines.length >= 2, 'something was logged');
  const all = lines.join('\n');
  assert.ok(!all.includes('9811100009') && !all.includes('9811100001'), `full phone logged:\n${all}`);
  assert.ok(all.includes('******0009'));
  assert.equal(sms.__mockOutbox().at(0).to, '******0009');
  await assert.rejects(sms.sendTemplate('12345', 't', {}), (err) => err.code === 'INVALID_PHONE');
});
