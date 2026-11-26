// The super admin's Transactions ledger: every payment in and out, from every source, as one
// list with totals, filters, the dashboard summary and an Excel export. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: SmsCreditPurchase } = await import('../models/SmsCreditPurchase.js');
const { default: JobApplication } = await import('../models/JobApplication.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: Payout } = await import('../models/Payout.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let seed;
let admin;
const oid = () => new mongoose.Types.ObjectId();
const ist = (s) => new Date(`${s}+05:30`);

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  seed = await seedBasics();
  const adminUser = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  admin = { authorization: `Bearer ${generateTokens(adminUser._id, 'admin').accessToken}` };

  const rid = seed.restaurant._id;
  const sellerId = oid();
  const riderId = oid();
  const appId = oid();
  await Seller.collection.insertOne({ _id: sellerId, businessName: 'Glow Salon', status: 'active' });
  await DeliveryPartner.collection.insertOne({ _id: riderId, fullName: 'Ravi Rider', phone: '9000000001' });

  await Order.collection.insertMany([
    // ₹500 online on 25 Nov, refunded ₹500 on 26 Nov.
    { _id: oid(), restaurantId: rid, type: 'delivery', status: 'cancelled', paymentStatus: 'refunded', paymentChannel: 'online', paymentMethod: 'online', paidAt: ist('2026-11-25T10:00:00'), charges: { grandTotal: 50000 }, grandTotal: 500, razorpayPaymentId: 'pay_ORDER1', refund: { status: 'processed', amountPaise: 50000, processedAt: ist('2026-11-26T09:00:00'), razorpayRefundId: 'rfnd_1' } },
    // ₹300 cash on delivery on 25 Nov — collected by the rider, not Yulo.
    { _id: oid(), restaurantId: rid, type: 'delivery', status: 'delivered', paymentStatus: 'paid', paymentChannel: 'cod', paymentMethod: 'cash', paidAt: ist('2026-11-25T12:00:00'), grandTotal: 300 },
    // Never paid — not a transaction.
    { _id: oid(), restaurantId: rid, type: 'delivery', status: 'pending', paymentStatus: 'pending', paymentChannel: 'online', grandTotal: 999, createdAt: ist('2026-11-25T12:00:00') },
    // A dine-in round — counted through its bill, never on its own.
    { _id: oid(), restaurantId: rid, type: 'dine_in', status: 'served', paymentStatus: 'paid', paymentChannel: 'online', paidAt: ist('2026-11-25T13:00:00'), grandTotal: 700 },
  ]);
  await Bill.collection.insertMany([
    { _id: oid(), restaurantId: rid, type: 'dine_in', status: 'paid', billNumber: 'INV-000007', paymentChannel: 'online', paidBy: 'online', paymentAmountPaise: 70000, grandTotal: 700, subtotal: 700, paidAt: ist('2026-11-25T13:05:00'), razorpayPaymentId: 'pay_BILL' },
    { _id: oid(), restaurantId: rid, type: 'dine_in', status: 'paid', billNumber: 'INV-000008', paymentChannel: 'counter', paidBy: 'cash', grandTotal: 150, subtotal: 150, paidAt: ist('2026-11-26T20:00:00') },
    // A delivery order's own bill — the order already counts it.
    { _id: oid(), restaurantId: rid, type: 'delivery', status: 'paid', paymentChannel: 'online', grandTotal: 300, subtotal: 300, paidAt: ist('2026-11-25T12:00:00') },
    { _id: oid(), restaurantId: rid, type: 'dine_in', status: 'open', grandTotal: 80, subtotal: 80 },
  ]);
  await SellerSubscription.collection.insertOne({ _id: oid(), sellerId, status: 'active', activatedAt: ist('2026-11-24T11:00:00'), billNumber: 'YSB-000001', planSnapshot: { name: 'Basic', totalPaise: 590000 }, payment: { method: 'razorpay', amountPaise: 590000, razorpayPaymentId: 'pay_PLAN' } });
  await SmsCreditPurchase.collection.insertOne({ _id: oid(), sellerId, status: 'paid', paidAt: ist('2026-11-24T12:00:00'), totalPaise: 11800, billNumber: 'YSB-000002', payment: { method: 'manual', amountPaise: 11800, manual: { mode: 'upi', reference: 'UPI123' } } });
  await JobApplication.collection.insertMany([
    { _id: appId, fullName: 'Asha Applicant', applicationNumber: 'YJ-000001', status: 'new', payment: { amountPaise: 10000, status: 'paid', paidAt: ist('2026-11-26T08:00:00'), razorpayPaymentId: 'pay_JOB' } },
    { _id: oid(), fullName: 'Unpaid', status: 'pending_payment', payment: { amountPaise: 10000, status: 'pending' } },
  ]);
  await StrayPayment.collection.insertOne({ _id: oid(), kind: 'job_application_duplicate_payment', jobApplicationId: appId, razorpayPaymentId: 'pay_DUP', amountPaise: 10000, createdAt: ist('2026-11-26T08:01:00'), refund: { status: 'processing', amountPaise: 10000, initiatedAt: ist('2026-11-26T09:30:00') } });
  await RestaurantSettlement.collection.insertMany([
    { _id: oid(), restaurantId: rid, status: 'paid', periodStart: ist('2026-11-17T00:00:00'), periodEnd: ist('2026-11-23T23:59:59'), totals: { netPayable: 120000 }, payout: { paidAt: ist('2026-11-25T18:00:00'), utr: 'UTR777' } },
    { _id: oid(), restaurantId: rid, status: 'approved', periodStart: ist('2026-11-24T00:00:00'), totals: { netPayable: 999900 }, payout: {} },
  ]);
  await Payout.collection.insertMany([
    { _id: oid(), partnerId: riderId, periodType: 'weekly', status: 'paid', paidAt: ist('2026-11-26T19:00:00'), netPayable: 845.5, periodStart: ist('2026-11-17T00:00:00'), paymentReference: 'UPI-RIDER' },
    // The monthly statement row of the same deliveries is never paid on its own.
    { _id: oid(), partnerId: riderId, periodType: 'monthly', status: 'paid', paidAt: ist('2026-11-26T19:00:00'), netPayable: 845.5 },
  ]);
});

const get = (q = {}) => srv.get(`/api/admin/transactions?${new URLSearchParams(q)}`, admin);

test('one ledger across every source, newest first, with the right totals', async () => {
  const res = await get({ from: '2026-11-20', to: '2026-11-30', limit: 50 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { transactions: rows, totals } = res.body.data;

  const kinds = rows.map((r) => r.kind).sort();
  assert.deepEqual(kinds, [
    'bill_payment', 'bill_payment', 'job_fee', 'order_payment', 'order_payment',
    'refund', 'refund', 'restaurant_payout', 'rider_payout', 'seller_plan', 'sms_credits', 'stray_payment',
  ]);
  const times = rows.map((r) => new Date(r.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

  // In through Yulo: order 500 + bill 700 + plan 5900 + sms 118 + job 100 + stray 100.
  assert.equal(totals.inPaise, 50000 + 70000 + 590000 + 11800 + 10000 + 10000);
  // Collected directly: COD 300 + counter 150.
  assert.equal(totals.collectedDirectPaise, 30000 + 15000);
  // Out: refunds 500 + 100, restaurant 1200, rider 845.50.
  assert.equal(totals.outPaise, 50000 + 10000 + 120000 + 84550);
  assert.equal(totals.netPaise, totals.inPaise - totals.outPaise);
  assert.equal(totals.count, 12);

  const byKind = (k) => rows.filter((r) => r.kind === k);
  assert.equal(byKind('job_fee')[0].party.name, 'Asha Applicant');
  assert.equal(byKind('job_fee')[0].reference, 'YJ-000001');
  assert.equal(byKind('seller_plan')[0].party.name, 'Glow Salon');
  assert.equal(byKind('sms_credits')[0].method, 'upi');
  assert.equal(byKind('sms_credits')[0].channel, 'manual');
  assert.equal(byKind('rider_payout')[0].party.name, 'Ravi Rider');
  assert.equal(byKind('rider_payout')[0].amountPaise, 84550);
  assert.equal(byKind('restaurant_payout')[0].gatewayId, 'UTR777');
  assert.equal(byKind('restaurant_payout')[0].party.name, seed.restaurant.name);
  const strayRefund = byKind('refund').find((r) => r.amountPaise === 10000);
  assert.equal(strayRefund.status, 'processing');
  assert.equal(strayRefund.party.name, 'Asha Applicant');
  assert.equal(byKind('stray_payment')[0].reference, 'Fee paid twice');
  assert.match(byKind('order_payment')[0].reference, /^Order #/);
});

test('filters: IST day range, direction, type, search, paging', async () => {
  // 26 Nov only (IST): refund 500, counter bill 150, job fee, stray, stray refund, rider payout.
  let res = await get({ from: '2026-11-26', to: '2026-11-26' });
  assert.equal(res.body.data.totals.count, 6);

  res = await get({ from: '2026-11-20', to: '2026-11-30', direction: 'out' });
  assert.ok(res.body.data.transactions.every((r) => r.direction === 'out'));
  assert.equal(res.body.data.totals.count, 4);
  assert.equal(res.body.data.totals.inPaise, 0);

  res = await get({ kind: 'seller_plan' });
  assert.equal(res.body.data.totals.count, 1);

  res = await get({ q: 'glow' });
  assert.deepEqual(res.body.data.transactions.map((r) => r.kind).sort(), ['seller_plan', 'sms_credits']);
  res = await get({ q: 'UTR777' });
  assert.equal(res.body.data.transactions[0].kind, 'restaurant_payout');
  res = await get({ q: 'YJ-000001' });
  assert.equal(res.body.data.transactions[0].kind, 'job_fee');

  res = await get({ limit: 5, page: 3 });
  assert.equal(res.body.data.transactions.length, 2);
  assert.equal(res.body.data.pages, 3);

  assert.equal((await get({ from: '2026-11-30', to: '2026-11-01' })).status, 400);
  assert.equal((await get({ from: '2026-02-30' })).status, 400);
  assert.equal((await get({ kind: 'bogus' })).status, 400);
});

test('dashboard summary and Excel export', async () => {
  const sum = await srv.get('/api/admin/transactions/summary', admin);
  assert.equal(sum.status, 200, JSON.stringify(sum.body));
  assert.ok(sum.body.data.today && sum.body.data.month);
  assert.equal(sum.body.data.latest.length, 8);

  const res = await fetch(`${srv.base}/api/admin/transactions/export.xlsx?from=2026-11-20&to=2026-11-30`, { headers: admin });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /transactions-2026-11-20-to-2026-11-30\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = wb.getWorksheet('Transactions');
  assert.equal(sheet.rowCount, 13);
  let sum2 = 0;
  sheet.eachRow((row, n) => {
    if (n > 1) sum2 += row.getCell(6).value;
  });
  // In − out, including what was collected at the counter / on delivery.
  assert.equal(Math.round(sum2 * 100), 741800 + 45000 - 264550);
});

test('admins only', async () => {
  const owner = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  assert.equal((await srv.get('/api/admin/transactions', owner)).status, 403);
  assert.equal((await srv.get('/api/admin/transactions')).status, 401);
});
