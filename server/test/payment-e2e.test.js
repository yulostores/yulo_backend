// B11 — the whole payment & settlement system, end to end, through the real HTTP API with a fake
// Razorpay and an in-memory MongoDB. One restaurant, one week, every case of the client's Payment
// Flow document plus a refund and a cancel-after-preparation, then the settlement generated,
// approved and paid by bank file — asserting every number the PDF gives.
//
//   Case 1  delivery, customer pays delivery            ₹357  → restaurant +₹302.50
//   Case 2  delivery, free delivery (restaurant pays ₹30) ₹327 → restaurant +₹273.55
//   Case 3  dine-in, guest pays online (QR)             ₹327  → restaurant +₹303.55
//   Case 4  dine-in, paid in cash at the counter        ₹327  → restaurant −₹12.42
//   Reject  paid delivery rejected by the restaurant          → refund, restaurant −Razorpay fee
//   Cancel  customer cancels after preparation started         → no refund, restaurant +₹302.50

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const { __setSettlementClockForTests } = await import('../services/settlement.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Table } = await import('../models/Table.js');
const { default: Order } = await import('../models/Order.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { generateTokens, generateStaffToken, generatePartnerTokens } = await import('../services/auth.service.js');

const RESTAURANT_AT = [77.59, 12.97];
// ~0.98 km east → charged as 1.0 km (rounded up to 0.1 km).
const DROP = [77.599, 12.97];

let mongo;
let srv;
let fake;
const h = {}; // auth headers by role
let restaurant;
let thali;
let customer;
let partner;

const req = (method, path, { headers, body } = {}) => srv.request(method, path, { headers, body });
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init()]);
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  __resetFinanceSettingsCache();
  srv = await startTestServer({ withSocket: true });

  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'Owner', email: 'owner@test.local', role: 'restaurant_owner' });
  customer = await User.create({
    name: 'Asha',
    phone: '9876543210',
    role: 'customer',
    savedAddresses: [{ street: '22 Lake Road', city: 'Bengaluru', pincode: '560001', location: { type: 'Point', coordinates: DROP }, locationSource: 'map_pin', isDefault: true }],
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
  const waiter = await StaffMember.create({ restaurantId: restaurant._id, staffCode: 'W01', name: 'Waiter', role: 'waiter', phone: '9000000002' });
  h.chef = { authorization: `Bearer ${generateStaffToken(chef._id, 'chef', restaurant._id, 0)}` };
  h.waiter = { authorization: `Bearer ${generateStaffToken(waiter._id, 'waiter', restaurant._id, 0)}` };

  partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'active', verificationStatus: 'approved' });
  h.partner = { authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` };

  // The PDF's ₹30 delivery: ₹25.42 + 18 % GST for the ~1 km trip. Everything else is the
  // business defaults (₹12 platform fee, 5 % food GST, 3.5 % settlement charge, ₹20 rider base).
  ok(await req('POST', '/api/admin/finance/settings', { headers: h.admin, body: { settings: { deliveryPerKmRate: 2542 }, note: 'PDF pricing for the e2e test' } }), 201);
});

after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

// ── Helpers that walk the real flows ──────────────────────────────────────────

const fill = async () => ok(await req('POST', '/api/cart/items', { headers: h.customer, body: { menuItemId: String(thali._id), qty: 1 } }), 201);

// Customer checks out online and pays (Razorpay fee as given). Returns the order id.
const checkoutAndPay = async ({ fee, tax }) => {
  await fill();
  const summary = ok(await srv.get('/api/checkout/summary', h.customer));
  const placed = ok(await req('POST', '/api/orders/checkout', { headers: h.customer, body: { paymentMethod: 'online' } }), 201);
  assert.deepEqual(placed.order.charges, summary.bill.charges, 'charged exactly what checkout showed');
  const rzp = placed.razorpayOrder;
  const paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`;
  fake.addPayment({ id: paymentId, order_id: rzp.id, amount: rzp.amount, fee, tax });
  ok(await req('POST', `/api/orders/${placed.orderId}/payment/verify`, {
    headers: h.customer,
    body: { razorpay_payment_id: paymentId, razorpay_order_id: rzp.id, razorpay_signature: checkoutSignature(rzp.id, paymentId) },
  }));
  return placed.orderId;
};

const accept = async (orderId) => ok(await req('PATCH', `/api/owner/${restaurant._id}/orders/${orderId}/accept`, { headers: h.owner }));
const chef = async (orderId, newStatus) =>
  ok(await req('PATCH', `/api/staff/${restaurant._id}/kitchen/orders/${orderId}/status`, { headers: h.chef, body: { newStatus } }));

// The rider side: the offer is placed exactly as autoAssign does once it finds this rider online
// (presence needs Redis, which the test has none of), then accept → pickup OTP → deliver over HTTP.
const riderDelivers = async (orderId) => {
  await Order.updateOne(
    { _id: orderId },
    { $set: { 'deliveryAssignment.offeredTo': partner._id, 'deliveryAssignment.offerStatus': 'offered', 'deliveryAssignment.offerExpiresAt': new Date(Date.now() + 60_000) } }
  );
  ok(await req('POST', `/api/partner/orders/${orderId}/accept`, { headers: h.partner }));
  const otp = (await Order.findById(orderId).lean()).deliveryAssignment.pickupOtp;
  ok(await req('POST', `/api/partner/orders/${orderId}/verify-pickup`, { headers: h.partner, body: { otp } }));
  ok(await req('POST', `/api/partner/orders/${orderId}/deliver`, { headers: h.partner, body: {} }));
};

// A guest at a table: QR order → restaurant accepts → kitchen → served.
const tableRound = async (identifier) => {
  const table = await Table.create({ restaurantId: restaurant._id, identifier });
  const placed = ok(
    await srv.request('POST', `/api/restaurants/${restaurant._id}/tables/${table._id}/orders`, {
      headers: { 'Idempotency-Key': `e2e-${identifier}` },
      body: { items: [{ menuItemId: String(thali._id), quantity: 1 }], guestName: 'Guest', guestPhone: '9123456780' },
    }),
    201
  );
  await accept(placed.order._id);
  await chef(placed.order._id, 'preparing');
  await chef(placed.order._id, 'ready');
  ok(await req('PATCH', `/api/staff/${restaurant._id}/waiter/orders/${placed.order._id}/status`, { headers: h.waiter, body: { newStatus: 'served' } }));
  return { table, sessionId: placed.tableSessionId };
};

// ── The week ──────────────────────────────────────────────────────────────────

const ids = {};

test('Case 1 — delivery ₹357: paid online, accepted, cooked, delivered by the rider', async () => {
  ids.case1 = await checkoutAndPay({ fee: 1138, tax: 174 });
  const order = await Order.findById(ids.case1).lean();
  assert.equal(order.grandTotal, 357);
  assert.equal(order.charges.delivery.customerPays, 3000);

  await accept(ids.case1);
  await chef(ids.case1, 'preparing');
  await chef(ids.case1, 'ready');
  await riderDelivers(ids.case1);

  const credit = await RestaurantLedgerEntry.findOne({ orderId: ids.case1 }).lean();
  assert.equal(credit.amountPaise, 30250);
  const rider = (await Order.findById(ids.case1).lean()).deliveryAssignment.earningsBreakdown;
  assert.equal(rider.basePay, 20, 'under 2 km → base pay only');
});

test('Case 2 — free delivery ₹327: the restaurant bears the ₹30', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'delivery.freeThreshold': 250 } });
  ids.case2 = await checkoutAndPay({ fee: 1042, tax: 159 });
  assert.equal((await Order.findById(ids.case2).lean()).grandTotal, 327);
  await accept(ids.case2);
  await chef(ids.case2, 'preparing');
  await chef(ids.case2, 'ready');
  await riderDelivers(ids.case2);
  assert.equal((await RestaurantLedgerEntry.findOne({ orderId: ids.case2 }).lean()).amountPaise, 27355);
  await Restaurant.updateOne({ _id: restaurant._id }, { $unset: { 'delivery.freeThreshold': 1 } });
});

test('Case 3 — dine-in ₹327 paid online by the guest from the QR menu', async () => {
  const { table } = await tableRound('T3');
  const base = `/api/restaurants/${restaurant._id}/tables/${table._id}/bill`;
  const pay = ok(await srv.request('POST', `${base}/pay`));
  assert.equal(pay.bill.charges.grandTotal, 327);
  const rzp = pay.razorpayOrder;
  fake.addPayment({ id: 'pay_case3', order_id: rzp.id, amount: rzp.amount, fee: 1042, tax: 159 });
  const verified = ok(await srv.request('POST', `${base}/verify`, {
    body: { razorpay_payment_id: 'pay_case3', razorpay_order_id: rzp.id, razorpay_signature: checkoutSignature(rzp.id, 'pay_case3') },
  }));
  ids.case3Bill = verified.bill._id;
  assert.equal((await RestaurantLedgerEntry.findOne({ billId: ids.case3Bill }).lean()).amountPaise, 30355);
});

test('Case 4 — dine-in ₹327 paid in cash at the counter: restaurant owes ₹12.42', async () => {
  const { sessionId } = await tableRound('T4');
  const bill = ok(await srv.get(`/api/staff/${restaurant._id}/waiter/sessions/${sessionId}/bill`, h.waiter));
  assert.equal(bill.bill.charges.grandTotal, 327);
  ok(await req('POST', `/api/staff/${restaurant._id}/waiter/sessions/${sessionId}/bill/mark-paid`, { headers: h.waiter, body: { method: 'cash' } }));
  const debit = await RestaurantLedgerEntry.findOne({ billId: bill.bill._id }).lean();
  assert.equal(debit.type, 'counter_platform_fee');
  assert.equal(debit.amountPaise, 1242);
});

test('Reject — a paid order the restaurant rejects is refunded; the restaurant bears Razorpay\'s fee', async () => {
  ids.rejected = await checkoutAndPay({ fee: 1138, tax: 174 });
  ok(await req('PATCH', `/api/owner/${restaurant._id}/orders/${ids.rejected}/reject`, { headers: h.owner, body: { reason: 'Restaurant is too busy right now' } }));

  assert.equal(fake.calls.refund.length, 1);
  assert.equal(fake.calls.refund[0].amount, 35700);
  const view = ok(await srv.get(`/api/orders/${ids.rejected}`, h.customer));
  assert.equal(view.order.refund.status, 'processing');
  assert.equal((await RestaurantLedgerEntry.findOne({ orderId: ids.rejected, type: 'refund_gateway_fee' }).lean()).amountPaise, 1138);
});

test('Cancel — customer cancels after preparation started: no refund, the restaurant is paid', async () => {
  ids.cancelled = await checkoutAndPay({ fee: 1138, tax: 174 });
  await accept(ids.cancelled);
  await chef(ids.cancelled, 'preparing');
  const refused = await req('POST', `/api/orders/${ids.cancelled}/cancel`, { headers: h.customer, body: {} });
  assert.equal(refused.body.code, 'CONFIRMATION_REQUIRED');
  const cancelled = ok(await req('POST', `/api/orders/${ids.cancelled}/cancel`, { headers: h.customer, body: { confirmNoRefund: true } }));
  assert.equal(cancelled.order.refund, null);
  assert.equal(fake.calls.refund.length, 1, 'no new refund');
  assert.equal((await RestaurantLedgerEntry.findOne({ orderId: ids.cancelled, type: 'order_earning' }).lean()).amountPaise, 30250);
});

test('Settlement — the week sums to the PDF nets minus the refund fee; margins and rider pay add up; approved and paid by bank file', async () => {
  const expectedNet = 30250 + 27355 + 30355 - 1242 - 1138 + 30250;

  // The orders were delivered this week; a week is only approved once it is over — move the
  // settlement clock past it.
  __setSettlementClockForTests(() => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
  // B12: online rows count from their Razorpay T+2 clearance, which — depending on the weekday
  // this runs — can land in next week while the counter row counts today. Treat every payment as
  // cleared now so the PDF week is one statement (the clearing calendar has its own tests,
  // test/b12-clearing.test.js).
  const now = new Date();
  await RestaurantLedgerEntry.updateMany({ restaurantId: restaurant._id }, { $set: { eligibleAt: now, clearsAt: now } });
  const generated = ok(await req('POST', '/api/admin/finance/settlements/generate', { headers: h.admin, body: { weekStart: new Date().toISOString() } }));
  assert.equal(generated.count, 1);
  const settlementId = generated.settlements[0]._id;

  const detail = ok(await srv.get(`/api/admin/finance/settlements/${settlementId}`, h.admin));
  const t = detail.settlement.totals;
  assert.equal(detail.settlement.entryCount, 6);
  assert.equal(t.netPayable, expectedNet);
  assert.equal(t.grossCustomerPaid, 35700 + 32700 + 32700 + 35700);
  assert.equal(t.yuloMoneyPlatformFee, 4 * 1200);
  assert.equal(t.yuloMoneyDelivery, 3000 + 3000, 'case 1 and the cancelled order');
  assert.equal(t.restaurantBorneDelivery, 3000, 'case 2');
  assert.equal(t.settlementCharge.total, 1250 + 1145 + 1145 + 1250);
  assert.equal(t.counterPlatformFees, 1242);
  assert.equal(t.refundGatewayFees, 1138);
  assert.equal(detail.settlement.status, 'draft');

  // Admin-only: Razorpay's actual fees on the paid-in money, Yulo's margin on the 3.5 %, rider pay.
  const fees = 1138 + 1042 + 1042 + 1138;
  assert.equal(detail.platformTotals.gatewayFees, fees);
  // Margin = the 3.5 % on online money minus Razorpay's fees on it, plus the 3.5 % on the cash
  // bill's platform fee (₹0.42 — no gateway fee against it; that charge sits inside
  // counterPlatformFees, not settlementCharge).
  assert.equal(detail.platformTotals.yuloSettlementMargin, t.settlementCharge.total - fees + 42);
  assert.equal(detail.platformTotals.riderPay, 2000 + 2000, 'cases 1 and 2 delivered by the rider');

  // The owner sees the same totals, none of the platform internals.
  const ownerView = ok(await srv.get(`/api/owner/${restaurant._id}/settlements/${settlementId}`, h.owner));
  assert.equal(ownerView.settlement.totals.netPayable, expectedNet);
  assert.doesNotMatch(JSON.stringify(ownerView), /yuloSettlementMargin|"gateway"/);

  // The rider's own earnings agree with what the restaurant side recorded.
  const earnings = ok(await srv.get('/api/partner/earnings?period=weekly', h.partner));
  assert.equal(earnings.orders, 2);
  assert.equal(earnings.totalEarned, 40);

  // Approve → pay by bank bulk file → reconcile the bank's result.
  ok(await req('PATCH', `/api/admin/finance/settlements/${settlementId}/approve`, { headers: h.admin }));
  const { batch } = ok(await req('POST', '/api/admin/finance/payout-batches', { headers: h.admin, body: {} }), 201);
  const file = await srv.get(`/api/admin/finance/payout-batches/${batch._id}/file`, h.admin);
  assert.equal(file.status, 200);
  assert.match(file.body, new RegExp(`123456789012,HDFC0001234,${(expectedNet / 100).toFixed(2)},IMPS`));
  const reference = file.body.trim().split('\n')[1].split(',')[0];
  const reconciled = ok(await req('POST', `/api/admin/finance/payout-batches/${batch._id}/reconcile`, {
    headers: h.admin,
    body: { csv: `Payment Reference,Status,UTR,Reason\n${reference},Success,HDFCN26101100042,` },
  }));
  assert.equal(reconciled.summary.paid, 1);

  const paid = ok(await srv.get(`/api/owner/${restaurant._id}/settlements/${settlementId}`, h.owner));
  assert.equal(paid.settlement.status, 'paid');
  assert.equal(paid.settlement.payout.utr, 'HDFCN26101100042');
});
