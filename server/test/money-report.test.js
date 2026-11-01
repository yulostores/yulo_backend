// The super admin's money view: Orders & Money (every order with what Yulo received, what the
// restaurant and the rider get, what Yulo keeps) and the Weekly Report it clears the week from —
// marking a restaurant and a rider paid with the bank reference, which the restaurant portal and
// the rider app then show. In-memory MongoDB, fake Razorpay.

import test, { after, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, checkoutSignature } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const { expireUnansweredOrders } = await import('../services/orderApproval.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Table } = await import('../models/Table.js');
const { default: Order } = await import('../models/Order.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { generateTokens, generateStaffToken, generatePartnerTokens } = await import('../services/auth.service.js');

const RESTAURANT_AT = [77.59, 12.97];
const DROP = [77.599, 12.97];
const INTERNAL = ['financials', 'razorpayFee', 'razorpayTax'];
const MIN = 60 * 1000;

let mongo;
let srv;
let fake;
const h = {};
let restaurant;
let thali;
let partner;

const req = (method, path, { headers, body } = {}) => srv.request(method, path, { headers, body });
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

before(async () => {
  mongo = await startMemoryMongo();
  await RestaurantLedgerEntry.init();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'Owner', email: 'owner@test.local', role: 'restaurant_owner' });
  const customer = await User.create({
    name: 'Asha',
    phone: '9876543210',
    role: 'customer',
    savedAddresses: [
      { street: '22 Lake Road', city: 'Bengaluru', pincode: '560001', location: { type: 'Point', coordinates: DROP }, locationSource: 'map_pin', isDefault: true },
    ],
  });
  h.admin = { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` };
  h.owner = { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` };
  h.customer = { authorization: `Bearer ${generateTokens(customer._id, 'customer').accessToken}` };

  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    gstRegistered: true,
    delivery: { radiusKm: 10 },
    settings: { serviceChargePercent: 0, gstNumber: '29AAPFU0939F1ZV' },
    payoutAccount: {
      accountHolderName: 'Spice Route Foods',
      accountNumberEncrypted: encryptField('123456789012'),
      accountNumberLast4: '9012',
      ifsc: 'HDFC0001234',
      accountType: 'current',
      status: 'verified',
    },
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Thalis' });
  thali = await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Thali', foodType: 'veg', sellingPrice: 300 });
  const chef = await StaffMember.create({ restaurantId: restaurant._id, staffCode: 'C01', name: 'Chef', role: 'chef', phone: '9000000001' });
  h.chef = { authorization: `Bearer ${generateStaffToken(chef._id, 'chef', restaurant._id, 0)}` };
  partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'busy', verificationStatus: 'approved' });
  h.partner = { authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` };
});

// ── Flow helpers ──────────────────────────────────────────────────────────────

const checkoutAndPay = async () => {
  ok(await req('POST', '/api/cart/items', { headers: h.customer, body: { menuItemId: String(thali._id), qty: 1 } }), 201);
  const placed = ok(await req('POST', '/api/orders/checkout', { headers: h.customer, body: { paymentMethod: 'online' } }), 201);
  const rzp = placed.razorpayOrder;
  const paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`;
  fake.addPayment({ id: paymentId, order_id: rzp.id, amount: rzp.amount, fee: 1138, tax: 174 });
  ok(await req('POST', `/api/orders/${placed.orderId}/payment/verify`, {
    headers: h.customer,
    body: { razorpay_payment_id: paymentId, razorpay_order_id: rzp.id, razorpay_signature: checkoutSignature(rzp.id, paymentId) },
  }));
  return placed.orderId;
};
const accept = async (orderId) => ok(await req('PATCH', `/api/owner/${restaurant._id}/orders/${orderId}/accept`, { headers: h.owner }));
const chef = (orderId, newStatus) =>
  req('PATCH', `/api/staff/${restaurant._id}/kitchen/orders/${orderId}/status`, { headers: h.chef, body: { newStatus } });
const offer = (orderId) =>
  Order.updateOne(
    { _id: orderId },
    { $set: { 'deliveryAssignment.offeredTo': partner._id, 'deliveryAssignment.offerStatus': 'offered', 'deliveryAssignment.offerExpiresAt': new Date(Date.now() + MIN) } }
  );
const riderAccepts = async (orderId) => {
  await offer(orderId);
  ok(await req('POST', `/api/partner/orders/${orderId}/accept`, { headers: h.partner }));
  return (await Order.findById(orderId).lean()).deliveryAssignment.pickupOtp;
};
const pickup = (orderId, otp) => req('POST', `/api/partner/orders/${orderId}/verify-pickup`, { headers: h.partner, body: { otp } });
const deliver = (orderId, body = {}) => req('POST', `/api/partner/orders/${orderId}/deliver`, { headers: h.partner, body });
const current = async () => ok(await srv.get('/api/partner/orders/current', h.partner));

// A paid, accepted delivery order the rider has accepted (status `status`).
const assignedOrder = async (status = 'preparing') => {
  const orderId = await checkoutAndPay();
  await accept(orderId);
  if (['preparing', 'ready'].includes(status)) ok(await chef(orderId, 'preparing'));
  if (status === 'ready') ok(await chef(orderId, 'ready'));
  const otp = await riderAccepts(orderId);
  return { orderId, otp };
};


const { generateWeeklySettlements } = await import('../services/settlement.service.js');
const { default: Payout } = await import('../models/Payout.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const DAY = 24 * 60 * 60 * 1000;

// A delivered, paid online order — then moved back 8 days, so its week has ended and its money
// has cleared (as if it were delivered last week).
const deliveredLastWeek = async () => {
  const { orderId, otp } = await assignedOrder('ready');
  ok(await pickup(orderId, otp));
  const code = (await Order.findById(orderId).select('+deliveryAssignment.deliveryOtp').lean()).deliveryAssignment.deliveryOtp;
  ok(await deliver(orderId, { otp: code }));
  const back = (d) => new Date(new Date(d).getTime() - 8 * DAY);
  const o = await Order.findById(orderId).lean();
  // Through the driver: Mongoose treats createdAt as immutable and would drop it silently.
  await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: back(o.createdAt), deliveredAt: back(o.deliveredAt), paidAt: back(o.paidAt ?? o.createdAt) } });
  const e = await RestaurantLedgerEntry.findOne({ orderId, type: 'order_earning' }).lean();
  await RestaurantLedgerEntry.updateOne({ _id: e._id }, { $set: { eligibleAt: back(o.deliveredAt), clearsAt: back(o.deliveredAt) } });
  return { orderId, lastWeek: back(new Date()) };
};

test('Orders & Money: each order shows what Yulo received, what the restaurant and rider get, and what Yulo keeps', async () => {
  const { orderId, lastWeek } = await deliveredLastWeek();
  const data = ok(await srv.get(`/api/admin/finance/money?weekStart=${lastWeek.toISOString()}`, h.admin));
  const row = data.rows.find((r) => String(r.id) === String(orderId));
  assert.ok(row, 'the order is listed');
  const entry = await RestaurantLedgerEntry.findOne({ orderId, type: 'order_earning' }).lean();
  const order = await Order.findById(orderId).select('+razorpayFee').lean();
  assert.equal(row.final, true);
  assert.equal(row.customerPaidPaise, order.charges.grandTotal);
  assert.equal(row.yuloReceivedPaise, order.charges.grandTotal);
  assert.equal(row.restaurantSharePaise, entry.amountPaise);
  assert.ok(row.riderPayPaise > 0, 'rider pay counted');
  assert.equal(row.gatewayFeePaise, order.razorpayFee);
  assert.equal(row.yuloKeepsPaise, row.yuloReceivedPaise - row.restaurantSharePaise - row.riderPayPaise - row.gatewayFeePaise);
  assert.equal(row.rider.name, 'Ravi');
  assert.equal(row.restaurantPayout.state, 'ready', 'cleared, waiting for the next statement');
  assert.equal(row.riderPayout.state, 'pending');
  assert.equal(data.totals.restaurantsPaise, entry.amountPaise);
  assert.equal(data.totals.ridersPaise, row.riderPayPaise);

  // Only admins.
  assert.equal((await srv.get('/api/admin/finance/money', h.owner)).status, 403);
});

test('Weekly Report: mark the restaurant and the rider paid with references; both sides then show Paid', async () => {
  const { orderId, lastWeek } = await deliveredLastWeek();
  await generateWeeklySettlements(lastWeek);

  let report = ok(await srv.get(`/api/admin/finance/weekly-report?weekStart=${lastWeek.toISOString()}`, h.admin));
  assert.equal(report.weekEnded, true);
  assert.equal(report.restaurants.length, 1);
  assert.equal(report.riders.length, 1);
  const r = report.restaurants[0];
  const rider = report.riders[0];
  assert.equal(r.canMarkPaid, true);
  assert.equal(rider.canMarkPaid, true);
  assert.equal(report.summary.restaurants.owedPaise, r.netPayablePaise);
  assert.equal(report.summary.riders.owedPaise, rider.netPayablePaise);

  // Restaurant: one step from the report (schedule → release → paid under the hood).
  ok(await req('POST', `/api/admin/finance/weekly-report/restaurants/${r.settlementId}/mark-paid`, {
    headers: h.admin,
    body: { reference: 'UTR123456789', expectedNetPaise: r.netPayablePaise },
  }));
  const s = await RestaurantSettlement.findById(r.settlementId).lean();
  assert.equal(s.status, 'paid');
  assert.equal(s.payout.utr, 'UTR123456789');
  // The restaurant portal's payout history shows it paid with the reference.
  const ownerHist = ok(await srv.get(`/api/owner/${restaurant._id}/payments/history`, h.owner));
  assert.ok(JSON.stringify(ownerHist).includes('UTR123456789'), 'owner sees the reference');

  // Rider: a duplicate reference is refused; a fresh one pays it.
  const dup = await req('POST', `/api/admin/finance/weekly-report/riders/${rider.payoutId}/mark-paid`, { headers: h.admin, body: { reference: 'UTR123456789' } });
  assert.equal(dup.status, 200, 'restaurant UTRs and rider references are separate books');
  const p = await Payout.findById(rider.payoutId).lean();
  assert.equal(p.status, 'paid');
  assert.equal(p.paymentReference, 'UTR123456789');
  const again = await req('POST', `/api/admin/finance/weekly-report/riders/${rider.payoutId}/mark-paid`, { headers: h.admin, body: { reference: 'UPI-REF-2' } });
  assert.equal(again.status, 409, 'already paid');

  // The rider app's payout list shows that week paid, with the reference.
  const mine = ok(await srv.get('/api/partner/earnings/payouts', h.partner));
  const week = mine.payouts.find((x) => String(x._id) === String(rider.payoutId));
  assert.equal(week.status, 'paid');
  assert.equal(week.paymentReference, 'UTR123456789');
  assert.ok(week.paidAt);

  report = ok(await srv.get(`/api/admin/finance/weekly-report?weekStart=${lastWeek.toISOString()}`, h.admin));
  assert.equal(report.summary.restaurants.owedPaise, 0);
  assert.equal(report.summary.riders.owedPaise, 0);
  assert.equal(report.summary.restaurants.paidCount, 1);
  assert.equal(report.summary.riders.paidCount, 1);
  const row = ok(await srv.get(`/api/admin/finance/money?weekStart=${lastWeek.toISOString()}`, h.admin)).rows.find((x) => String(x.id) === String(orderId));
  assert.equal(row.restaurantPayout.state, 'paid');
  assert.equal(row.riderPayout.state, 'paid');
});

test('the current week cannot be marked paid; a restaurant UTR cannot be reused', async () => {
  const { lastWeek } = await deliveredLastWeek();
  await generateWeeklySettlements(lastWeek);
  const report = ok(await srv.get(`/api/admin/finance/weekly-report?weekStart=${lastWeek.toISOString()}`, h.admin));
  // Another settlement already holding the UTR.
  await RestaurantSettlement.create({ restaurantId: restaurant._id, periodStart: new Date(0), periodEnd: new Date(1), status: 'paid', payout: { utr: 'UTR-TAKEN-1' } });
  const dup = await req('POST', `/api/admin/finance/weekly-report/restaurants/${report.restaurants[0].settlementId}/mark-paid`, { headers: h.admin, body: { reference: 'UTR-TAKEN-1' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'DUPLICATE_REFERENCE');

  // This week's rider payout (still running) is not payable.
  const { orderId } = await assignedOrder('ready').then(async (a) => { ok(await pickup(a.orderId, a.otp)); return a; });
  const code = (await Order.findById(orderId).select('+deliveryAssignment.deliveryOtp').lean()).deliveryAssignment.deliveryOtp;
  ok(await deliver(orderId, { otp: code }));
  const now = ok(await srv.get('/api/admin/finance/weekly-report?weekStart=' + new Date().toISOString(), h.admin));
  assert.equal(now.weekEnded, false);
  const res = await req('POST', `/api/admin/finance/weekly-report/riders/${now.riders[0].payoutId}/mark-paid`, { headers: h.admin, body: { reference: 'UPI-EARLY' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'WEEK_NOT_ENDED');
});

test('a week held for "bank account not verified" becomes payable as soon as the account is verified', async () => {
  const submittedAt = new Date();
  await Restaurant.updateOne(
    { _id: restaurant._id },
    { $set: { 'payoutAccount.status': 'pending_verification', 'payoutAccount.submittedAt': submittedAt } }
  );
  const { lastWeek } = await deliveredLastWeek();
  await generateWeeklySettlements(lastWeek);
  let s = await RestaurantSettlement.findOne({ restaurantId: restaurant._id }).lean();
  assert.equal(s.status, 'on_hold');
  assert.equal(s.holdReason, 'PAYOUT_ACCOUNT_NOT_VERIFIED');

  ok(await req('PATCH', `/api/admin/stores/${restaurant._id}/payout-account/verify`, { headers: h.admin, body: { submittedAt: submittedAt.toISOString() } }));
  s = await RestaurantSettlement.findById(s._id).lean();
  assert.equal(s.status, 'draft', 'eligible without regenerating the week by hand');
  assert.equal(s.holdReason, null);
  const report = ok(await srv.get(`/api/admin/finance/weekly-report?weekStart=${lastWeek.toISOString()}`, h.admin));
  assert.equal(report.restaurants[0].canMarkPaid, true);
});

test('Payouts → Live: this week\'s orders show per restaurant as they happen, before any statement', async () => {
  // One delivered just now (paid online → clearing), one accepted but not delivered yet (estimate).
  const { orderId, otp } = await assignedOrder('ready');
  ok(await pickup(orderId, otp));
  const code = (await Order.findById(orderId).select('+deliveryAssignment.deliveryOtp').lean()).deliveryAssignment.deliveryOtp;
  ok(await deliver(orderId, { otp: code }));
  const pending = await checkoutAndPay();
  await accept(pending);

  const live = ok(await srv.get('/api/admin/finance/payouts/live', h.admin));
  assert.equal(live.weekEnded, false);
  assert.equal(live.totals.orders, 2);
  assert.equal(live.totals.inProgress, 1);
  const r = live.restaurants.find((x) => String(x.restaurant._id) === String(restaurant._id));
  const entry = await RestaurantLedgerEntry.findOne({ orderId, type: 'order_earning' }).lean();
  assert.equal(r.orders, 2);
  assert.equal(r.earnedPaise, entry.amountPaise, 'the delivered order is booked');
  assert.equal(r.clearingPaise, entry.amountPaise, 'and still clearing (paid less than 2 working days ago)');
  assert.ok(r.projectedPaise > 0, 'the order in progress is shown as an estimate');
  assert.ok(r.ridersPaise > 0);
  assert.equal(live.latest.length, 2);
  assert.equal((await srv.get('/api/admin/finance/payouts/live', h.owner)).status, 403);
});

test('Weekly Report: ₹0 riders are not listed or counted; a restaurant owing Yulo is shown as such', async () => {
  const lastWeek = new Date(Date.now() - 8 * DAY);
  const { weekBounds } = await import('../utils/week.js');
  const { start, end } = weekBounds(lastWeek, { timezone: 'Asia/Kolkata', weekStartsOn: 'monday' });
  // A rider with no deliveries whose ₹0 row the old "Clear Pending Payments" marked paid.
  const idle = await DeliveryPartner.create({ phone: '9222222222', fullName: 'Idle Rider', status: 'active', verificationStatus: 'approved' });
  await Payout.create({ partnerId: idle._id, periodType: 'weekly', periodStart: start, periodEnd: end, perDeliveryRate: 20, netPayable: 0, status: 'paid', paidAt: new Date() });
  // The restaurant's only money that week: platform fee owed on a counter-paid bill.
  await RestaurantLedgerEntry.create({
    restaurantId: restaurant._id, type: 'counter_platform_fee', direction: 'debit', amountPaise: 1242,
    eligibleAt: new Date(start.getTime() + DAY), clearsAt: new Date(start.getTime() + DAY), note: 'counter bill',
  });
  await generateWeeklySettlements(lastWeek);

  const report = ok(await srv.get(`/api/admin/finance/weekly-report?weekStart=${lastWeek.toISOString()}`, h.admin));
  assert.equal(report.riders.length, 0, 'the ₹0 rider is not listed');
  assert.equal(report.summary.riders.paidCount, 0);
  assert.equal(report.summary.restaurants.owedPaise, 0);
  assert.equal(report.summary.restaurants.owesYuloCount, 1);
  assert.equal(report.summary.restaurants.owesYuloPaise, 1242);
  assert.equal(report.restaurants[0].carriedForwardPaise, 1242);
  assert.equal(report.restaurants[0].canMarkPaid, false);
});
