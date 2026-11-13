// Seller bills (super admin): one numbered bill per paid plan or SMS-credit purchase — online
// (with the 3.5 % handling fee) or offline ("Amount Received") — the list with its report, the
// filters, one bill in full, the PDF download and the CSV report. Fake Razorpay, in-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, checkoutSignature } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller } = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const bills = await import('../services/sellerBills.service.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: SmsCreditPurchase } = await import('../models/SmsCreditPurchase.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let fake;
let category;
let adminHeaders;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([SellerSubscription.init(), SmsCreditPurchase.init(), Coupon.init()]);
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
  category = await makeCategory({ key: 'salon-b', name: 'Salon' });
  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
});

const admin$ = (method, path, body) => srv.request(method, `/api/admin${path}`, { body, headers: adminHeaders });
const seller = (over = {}) => makeCompleteSeller({ status: 'active', categoryId: category._id, ...over });

// An online plan purchase, paid and verified: ₹5,000 + ₹175 fee + ₹931.50 GST = ₹6,106.50.
const buyOnline = async (headers) => {
  const started = await srv.request('POST', '/api/seller/subscriptions', { body: { planKey: 'basic' }, headers });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { subscription, razorpayOrder } = started.body.data;
  fake.addPayment({ id: 'pay_online_1', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  const res = await srv.request('POST', `/api/seller/subscriptions/${subscription._id}/verify`, {
    body: { razorpay_order_id: razorpayOrder.id, razorpay_payment_id: 'pay_online_1', razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_online_1') },
    headers,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return subscription._id;
};
const planOffline = (sellerId, reference = 'UTR-1') =>
  admin$('POST', `/sellers/${sellerId}/subscriptions/manual`, { planKey: 'basic', amountRupees: 5900, mode: 'neft', reference, receivedOn: new Date().toISOString() });
const smsOffline = (sellerId, reference = 'UPI-9') =>
  admin$('POST', `/sellers/${sellerId}/sms-credits/manual`, { credits: 100, amountRupees: 354, mode: 'upi', reference, receivedOn: new Date().toISOString() });

const threeBills = async () => {
  const a = await seller();
  const b = await seller({ phone: '9000000077' });
  await buyOnline(a.headers);
  assert.equal((await planOffline(b.seller._id)).status, 201);
  assert.equal((await smsOffline(a.seller._id)).status, 201);
  return { a, b };
};

test('every paid purchase gets the next bill number the moment it is paid; pending purchases are not bills', async () => {
  const { a } = await threeBills();
  const subs = await SellerSubscription.find().sort({ activatedAt: 1 }).lean();
  assert.deepEqual(subs.map((s) => s.billNumber), ['YSB-000001', 'YSB-000002']);
  assert.equal((await SmsCreditPurchase.findOne().lean()).billNumber, 'YSB-000003');

  // A purchase started but never paid has no bill.
  await srv.request('POST', '/api/seller/subscriptions', { body: { planKey: 'plus' }, headers: a.headers });
  const list = (await admin$('GET', '/seller-bills')).body.data;
  assert.equal(list.total, 3);
  assert.deepEqual(list.bills.map((b) => b.billNumber), ['YSB-000003', 'YSB-000002', 'YSB-000001'], 'newest first');
});

test('the report: totals, handling fees and GST over the filtered bills, split by kind and payment method', async () => {
  await threeBills();
  const { summary, bills: rows } = (await admin$('GET', '/seller-bills')).body.data;
  assert.deepEqual(
    { count: summary.count, base: summary.basePaise, fee: summary.handlingFeePaise, gst: summary.gstPaise, total: summary.totalPaise },
    { count: 3, base: 500_000 + 500_000 + 30_000, fee: 17_500, gst: 93_150 + 90_000 + 5_400, total: 610_650 + 590_000 + 35_400 },
  );
  assert.deepEqual(summary.byKind, { plan: { count: 2, totalPaise: 1_200_650 }, sms: { count: 1, totalPaise: 35_400 } });
  assert.deepEqual(summary.byMethod, { online: { count: 1, totalPaise: 610_650 }, manual: { count: 2, totalPaise: 625_400 } });
  const online = rows.find((r) => r.billNumber === 'YSB-000001');
  assert.deepEqual(online.amount, { base: 5000, handlingFee: 175, gst: 931.5, total: 6106.5, paid: 6106.5 });
  assert.equal(online.method, 'online');
  assert.equal(online.reference, 'pay_online_1');
});

test('filters: kind, payment method, seller, search and dates', async () => {
  const { a, b } = await threeBills();
  const numbers = async (qs) => (await admin$('GET', `/seller-bills?${qs}`)).body.data.bills.map((r) => r.billNumber);
  assert.deepEqual(await numbers('kind=sms'), ['YSB-000003']);
  assert.deepEqual(await numbers('kind=plan&method=manual'), ['YSB-000002']);
  assert.deepEqual(await numbers(`seller=${a.seller._id}`), ['YSB-000003', 'YSB-000001']);
  await mongoose.model('Seller').updateOne({ _id: b.seller._id }, { $set: { businessName: 'Calm Spa' } });
  assert.deepEqual(await numbers('q=calm'), ['YSB-000002'], 'by seller name');
  assert.deepEqual(await numbers('q=UPI-9'), ['YSB-000003'], 'by reference');
  assert.deepEqual(await numbers('q=ysb-000001'), ['YSB-000001'], 'by bill number');
  assert.deepEqual(await numbers('from=2000-01-01&to=2000-01-31'), []);
  assert.equal((await admin$('GET', '/seller-bills?from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await admin$('GET', `/seller-bills?seller=${b.seller._id}&page=2&limit=1`)).body.data.bills.length, 0);
});

test('one bill in full: issued by, billed to, lines (handling fee only when online), payment; 404 otherwise', async () => {
  const { a } = await threeBills();
  const online = await SellerSubscription.findOne({ billNumber: 'YSB-000001' }).lean();
  const { bill } = (await admin$('GET', `/seller-bills/${online._id}`)).body.data;
  assert.equal(bill.issuedBy.name, 'Yulo Stores Technologies Pvt. Ltd.');
  assert.equal(bill.billedTo.name, a.seller.businessName);
  assert.deepEqual(bill.lines.map((l) => [l.label, l.amountPaise]), [
    ['Basic plan — 250 coupons', 500_000],
    ['Payment handling fee (3.5%)', 17_500],
    ['GST (18%)', 93_150],
  ]);
  assert.equal(bill.totalPaise, 610_650);
  assert.equal(bill.payment.methodLabel, 'Online (Razorpay)');

  const offline = await SellerSubscription.findOne({ billNumber: 'YSB-000002' }).lean();
  const o = (await admin$('GET', `/seller-bills/${offline._id}`)).body.data.bill;
  assert.deepEqual(o.lines.map((l) => l.label), ['Basic plan — 250 coupons', 'GST (18%)'], 'no handling fee offline');
  assert.deepEqual([o.payment.methodLabel, o.payment.modeLabel, o.payment.reference], ['Amount Received', 'Bank transfer', 'UTR-1']);

  const sms = await SmsCreditPurchase.findOne().lean();
  const s = (await admin$('GET', `/seller-bills/${sms._id}`)).body.data.bill;
  assert.equal(s.kind, 'sms');
  assert.deepEqual(s.lines.map((l) => [l.label, l.amountPaise]), [['100 SMS credits @ ₹3', 30_000], ['GST (18%)', 5_400]]);

  const pending = await SellerSubscription.create({ ...online, _id: undefined, status: 'pending_payment', activatedAt: null, billNumber: null, payment: { method: 'razorpay' } });
  assert.equal((await admin$('GET', `/seller-bills/${pending._id}`)).status, 404);
  assert.equal((await admin$('GET', `/seller-bills/${new mongoose.Types.ObjectId()}`)).status, 404);
  assert.equal((await admin$('GET', '/seller-bills/not-an-id')).status, 404);
});

test('download: the bill as a PDF, the list as CSV with a totals row', async () => {
  await threeBills();
  const online = await SellerSubscription.findOne({ billNumber: 'YSB-000001' }).lean();
  const res = await admin$('GET', `/seller-bills/${online._id}/pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="YSB-000001\.pdf"/);
  const { text } = await bills.sellerBillPdf(online._id);
  for (const s of ['Bill YSB-000001', 'Payment handling fee (3.5%)', '₹6,106.50', 'Online (Razorpay)', 'pay_online_1']) assert.ok(text.includes(s), s);

  const csv = await admin$('GET', '/seller-bills/export.csv?kind=plan');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '"Bill number","Paid on (IST)","Seller","City","For","Description","Price (₹)","Handling fee (₹)","GST (₹)","Total (₹)","Paid (₹)","Paid by","Reference"');
  assert.equal(lines.length, 4, 'header + 2 plan bills + totals');
  assert.ok(lines.at(-1).startsWith('"Total","","","","2 bills","","10000","175","1831.5","12006.5"'), lines.at(-1));
});

test('purchases paid before bills existed are numbered in the order they were paid', async () => {
  const a = await seller();
  await planOffline(a.seller._id, 'UTR-A');
  await planOffline(a.seller._id, 'UTR-B');
  await SellerSubscription.updateMany({}, { $set: { billNumber: null } });
  const subs = await SellerSubscription.find().sort({ activatedAt: 1 }).lean();
  await SellerSubscription.updateOne({ _id: subs[0]._id }, { $set: { activatedAt: new Date('2026-01-01T00:00:00Z') } });
  const list = (await admin$('GET', '/seller-bills')).body.data;
  const first = list.bills.find((r) => r.id === String(subs[0]._id));
  const second = list.bills.find((r) => r.id === String(subs[1]._id));
  assert.ok(first.billNumber < second.billNumber, `${first.billNumber} before ${second.billNumber}`);
});

test('admins only', async () => {
  const { a } = await threeBills();
  assert.equal((await srv.request('GET', '/api/admin/seller-bills', {})).status, 401);
  assert.equal((await srv.request('GET', '/api/admin/seller-bills', { headers: a.headers })).status, 401);
});
