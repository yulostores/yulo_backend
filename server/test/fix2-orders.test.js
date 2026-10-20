// Round-2 fixes — the order lifecycle around payments: a cancelled order leaves the rider's hands
// (and can't be collected or "delivered"), the admin can cancel, the approval clock runs from
// payment, rider deliver/COD guards, public restaurant reads hide the bank account, placement
// responses carry no internal money keys, body-parser errors are 4xx, the socket server survives
// without Redis, and checkout can refuse a changed total. In-memory MongoDB, fake Razorpay.

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

const assertReleased = async (orderId, otp, { expectedAssignment = 'unassigned' } = {}) => {
  const order = await Order.findById(orderId).lean();
  assert.equal(order.status, 'cancelled');
  assert.equal(order.deliveryAssignment.status, expectedAssignment);
  assert.equal(order.deliveryAssignment.history.at(-1).reason, 'order_cancelled');
  assert.equal((await current()).kind, 'none', 'no longer on the rider\'s screen');
  if (otp && expectedAssignment === 'unassigned') {
    const res = await pickup(orderId, otp);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'ORDER_CANCELLED');
  }
  const res = await deliver(orderId);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ORDER_CANCELLED');
  const after = await Order.findById(orderId).lean();
  assert.equal(after.status, 'cancelled', 'never flipped to delivered');
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId, type: 'order_earning' }), 0, 'no credit for a cancelled order');
  assert.equal((await DeliveryPartner.findById(partner._id).lean()).status, 'active', 'rider freed from busy');
};

// ── 1. Cancelled orders leave the rider ───────────────────────────────────────

test('kitchen cancel with a rider assigned: rider released, pickup/deliver refused, one refund, no credit', async () => {
  const { orderId, otp } = await assignedOrder('ready');
  const refundsBefore = fake.calls.refund.length;
  ok(await chef(orderId, 'cancelled'));
  assert.equal(fake.calls.refund.length - refundsBefore, 1, 'one full refund');
  await assertReleased(orderId, otp);
});

test('customer cancel of an accepted order with a rider assigned: released, refunded', async () => {
  const orderId = await checkoutAndPay();
  await accept(orderId);
  const otp = await riderAccepts(orderId);
  ok(await req('POST', `/api/orders/${orderId}/cancel`, { headers: h.customer, body: {} }));
  await assertReleased(orderId, otp);
});

test('customer cancel after preparation (confirmNoRefund) with a rider assigned: released, order stays cancelled', async () => {
  const { orderId, otp } = await assignedOrder('preparing');
  ok(await req('POST', `/api/orders/${orderId}/cancel`, { headers: h.customer, body: { confirmNoRefund: true } }));
  const order = await Order.findById(orderId).lean();
  assert.equal(order.deliveryAssignment.status, 'unassigned');
  assert.equal((await current()).kind, 'none');
  const res = await pickup(orderId, otp);
  assert.equal(res.body.code, 'ORDER_CANCELLED');
  assert.equal((await Order.findById(orderId).lean()).status, 'cancelled');
});

test('cancelled after the rider collected the food: assignment failed, deliver refused', async () => {
  const { orderId, otp } = await assignedOrder('ready');
  ok(await pickup(orderId, otp));
  ok(await chef(orderId, 'cancelled'));
  await assertReleased(orderId, null, { expectedAssignment: 'failed' });
});

test('a pending offer is withdrawn on cancel; accepting it afterwards is refused', async () => {
  const orderId = await checkoutAndPay();
  await accept(orderId);
  await offer(orderId);
  ok(await chef(orderId, 'cancelled'));
  assert.equal((await Order.findById(orderId).lean()).deliveryAssignment.offerStatus, 'expired');
  const res = await req('POST', `/api/partner/orders/${orderId}/accept`, { headers: h.partner });
  assert.equal(res.status, 409);
  assert.equal((await current()).kind, 'none');
});

test('once the rider handed the food over, the order can no longer be cancelled', async () => {
  const { orderId } = await assignedOrder('ready');
  await Order.updateOne({ _id: orderId }, { $set: { 'deliveryAssignment.status': 'delivered' } });
  const res = await chef(orderId, 'cancelled');
  assert.equal(res.status, 409);
  assert.equal((await Order.findById(orderId).lean()).status, 'ready');
});

test('a dine-in round can\'t be cancelled while its table\'s bill is being paid online', async () => {
  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'T9' });
  const placed = ok(await srv.request('POST', `/api/restaurants/${restaurant._id}/tables/${table._id}/orders`, {
    headers: { 'Idempotency-Key': 'fix2-round' },
    body: { items: [{ menuItemId: String(thali._id), quantity: 1 }], guestName: 'Guest', guestPhone: '9123456780' },
  }), 201);
  await accept(placed.order._id);
  ok(await chef(placed.order._id, 'preparing'));
  await TableSession.updateOne({ _id: placed.tableSessionId }, { $set: { status: 'bill_requested' } });
  await Bill.collection.insertOne({
    restaurantId: restaurant._id,
    tableSessionId: new mongoose.Types.ObjectId(String(placed.tableSessionId)),
    status: 'open',
    paymentIntentId: 'order_fake_held',
  });
  const res = await chef(placed.order._id, 'cancelled');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PAYMENT_IN_PROGRESS');
  assert.equal((await Order.findById(placed.order._id).lean()).status, 'preparing');
});

// ── 6. Admin cancel ──────────────────────────────────────────────────────────

test('admin cancel: refunds, releases the rider, is audit-logged; owners and bad input refused', async () => {
  const { orderId, otp } = await assignedOrder('preparing');
  const path = `/api/admin/orders/${orderId}/cancel`;

  assert.equal((await req('PATCH', path, { headers: h.owner, body: { reason: 'Customer complaint' } })).status, 403);
  assert.equal((await req('PATCH', path, { headers: h.admin, body: {} })).status, 400);
  assert.equal((await req('PATCH', '/api/admin/orders/not-an-id/cancel', { headers: h.admin, body: { reason: 'xyz' } })).status, 400);

  const refundsBefore = fake.calls.refund.length;
  const data = ok(await req('PATCH', path, { headers: h.admin, body: { reason: 'Restaurant unreachable' } }));
  assert.equal(data.order.status, 'cancelled');
  for (const key of INTERNAL) assert.equal(key in data.order, false, `${key} not in the response`);
  assert.equal(fake.calls.refund.length - refundsBefore, 1);
  const order = await Order.findById(orderId).lean();
  assert.equal(order.cancelledBy, 'admin');
  assert.equal(order.cancellationReason, 'Restaurant unreachable');
  await assertReleased(orderId, otp);

  const log = await AdminActivityLog.findOne({ action: 'ORDER_CANCELLED', targetId: orderId }).lean();
  assert.ok(log, 'audit row written');
  assert.equal(log.metadata.previousStatus, 'preparing');

  const again = await req('PATCH', path, { headers: h.admin, body: { reason: 'Restaurant unreachable' } });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'ORDER_NOT_CANCELLABLE');
});

// ── 5. Approval clock from payment ───────────────────────────────────────────

test('approval timeout counts from payment for an online order, from creation otherwise', async () => {
  const now = Date.now();
  const base = { restaurantId: restaurant._id, type: 'delivery', status: 'placed', items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }], subtotal: 300 };
  // Created 14.5 min ago, paid just now: the restaurant has had it for seconds.
  const paidLate = await Order.create({ ...base, paymentMethod: 'online', paymentStatus: 'pending' });
  await Order.collection.updateOne({ _id: paidLate._id }, { $set: { createdAt: new Date(now - 14.5 * MIN) } });
  await Order.updateOne({ _id: paidLate._id }, { $set: { paymentStatus: 'paid' } });
  const stamped = await Order.findById(paidLate._id).lean();
  assert.ok(stamped.paidAt && Math.abs(stamped.paidAt.getTime() - now) < MIN, 'paidAt stamped by the model hook');

  const cash = await Order.create({ ...base, paymentMethod: 'cash', paymentStatus: 'pending' });
  await Order.collection.updateOne({ _id: cash._id }, { $set: { createdAt: new Date(now - 16 * MIN) } });

  // One minute later: the cash order (16 min old) times out; the online one (paid 1 min ago) doesn't.
  await expireUnansweredOrders({ now: new Date(now + MIN) });
  assert.equal((await Order.findById(cash._id).lean()).status, 'cancelled');
  assert.equal((await Order.findById(paidLate._id).lean()).status, 'placed');

  // 16 minutes after payment it does.
  await expireUnansweredOrders({ now: new Date(now + 16 * MIN) });
  assert.equal((await Order.findById(paidLate._id).lean()).status, 'cancelled');
});

test('the customer\'s approval countdown runs from payment too', async () => {
  const orderId = await checkoutAndPay();
  await Order.collection.updateOne({ _id: orderId }, { $set: { createdAt: new Date(Date.now() - 14 * MIN) } });
  const tracking = ok(await srv.get(`/api/orders/${orderId}/tracking`, h.customer));
  assert.ok(tracking.approvalSecondsLeft > 14 * 60, `about 15 min left, got ${tracking.approvalSecondsLeft}s`);
});

// ── 3 / 4. Rider deliver guards ──────────────────────────────────────────────

test('a rider delivering an unpaid online order does not mark it paid', async () => {
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'out_for_delivery',
    items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 357,
    paymentMethod: 'online',
    paymentStatus: 'pending',
    deliveryAssignment: { partnerId: partner._id, status: 'picked_up', offerStatus: 'accepted' },
  });
  ok(await deliver(order._id));
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
});

test('codCollected: absurd or sub-paisa amounts are refused before anything changes', async () => {
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'out_for_delivery',
    items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 357,
    paymentMethod: 'cash',
    paymentStatus: 'pending_cod',
    deliveryAssignment: { partnerId: partner._id, status: 'picked_up', offerStatus: 'accepted' },
  });
  for (const codCollected of [1e300, 357.123]) {
    const res = await deliver(order._id, { codCollected });
    assert.equal(res.status, 400, String(codCollected));
  }
  assert.equal((await deliver(order._id, {})).status, 400, 'missing amount refused');
  assert.equal((await Order.findById(order._id).lean()).deliveryAssignment.status, 'picked_up', 'nothing claimed');
  ok(await deliver(order._id, { codCollected: 357.5 }));
  const done = await Order.findById(order._id).lean();
  assert.equal(done.deliveryAssignment.codDiscrepancy, 0.5);
  assert.equal(done.status, 'delivered');
});

// ── 2. Public restaurant reads hide the bank account ─────────────────────────

test('public restaurant list, detail and favourites never carry payoutAccount', async () => {
  // No bank detail at all — an empty `payoutAccount: {}` container (every sub-field excluded)
  // is acceptable on the .select() surfaces.
  const hasBank = (doc) => {
    const json = JSON.stringify(doc);
    return ['HDFC0001234', 'Spice Route Foods', '"9012"', 'accountNumber', 'ifsc', 'verifiedBy'].some((s) => json.includes(s));
  };
  const list = ok(await srv.get(`/api/restaurants?lat=${RESTAURANT_AT[1]}&lng=${RESTAURANT_AT[0]}`));
  assert.ok(JSON.stringify(list).includes('Spice Route'), 'the restaurant is listed');
  assert.equal(hasBank(list), false, 'list');
  const detail = ok(await srv.get(`/api/restaurants/${restaurant._id}`));
  assert.equal(hasBank(detail), false, 'detail');
  assert.equal((await req('POST', `/api/users/me/favorites/restaurants/${restaurant._id}`, { headers: h.customer })).status, 201);
  const favs = ok(await srv.get('/api/users/me/favorites/restaurants', h.customer));
  assert.ok(JSON.stringify(favs).includes('Spice Route'), 'the favourite is listed');
  assert.equal(hasBank(favs), false, 'favourites');
});

// ── 8. Placement responses ───────────────────────────────────────────────────

test('order placement responses carry no internal money keys', async () => {
  ok(await req('POST', '/api/cart/items', { headers: h.customer, body: { menuItemId: String(thali._id), qty: 1 } }), 201);
  const checkout = ok(await req('POST', '/api/orders/checkout', { headers: h.customer, body: { paymentMethod: 'online' } }), 201);
  for (const key of INTERNAL) assert.equal(key in checkout.order, false, `checkout ${key}`);
  assert.ok(checkout.order.paymentIntentId, 'the Razorpay order is still recorded on the returned order');

  const raw = ok(await req('POST', '/api/orders', {
    headers: h.customer,
    body: { restaurantId: String(restaurant._id), type: 'takeaway', items: [{ menuItemId: String(thali._id), quantity: 1 }], paymentMethod: 'cash' },
  }), 201);
  for (const key of INTERNAL) assert.equal(key in raw.order, false, `raw ${key}`);

  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'T1' });
  const guest = ok(await srv.request('POST', `/api/restaurants/${restaurant._id}/tables/${table._id}/orders`, {
    headers: { 'Idempotency-Key': 'fix2-guest' },
    body: { items: [{ menuItemId: String(thali._id), quantity: 1 }], guestName: 'Guest', guestPhone: '9123456780' },
  }), 201);
  for (const key of INTERNAL) assert.equal(key in guest.order, false, `guest ${key}`);
});

// ── 13. PRICE_CHANGED ────────────────────────────────────────────────────────

test('checkout with the shown total refuses a changed price and creates nothing', async () => {
  ok(await req('POST', '/api/cart/items', { headers: h.customer, body: { menuItemId: String(thali._id), qty: 1 } }), 201);
  const summary = ok(await srv.get('/api/checkout/summary', h.customer));
  const shown = summary.bill.charges.grandTotal;

  ok(await req('POST', '/api/admin/finance/settings', { headers: h.admin, body: { settings: { customerPlatformFee: 1500 } } }), 201);
  const res = await req('POST', '/api/orders/checkout', {
    headers: { ...h.customer, 'Idempotency-Key': 'fix2-price' },
    body: { paymentMethod: 'online', expectedTotalPaise: shown },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PRICE_CHANGED');
  assert.ok(res.body.details.charges.grandTotal > shown);
  assert.equal(await Order.countDocuments({}), 0, 'no order created');

  // The same key, now with the new total, goes through.
  const placed = ok(await req('POST', '/api/orders/checkout', {
    headers: { ...h.customer, 'Idempotency-Key': 'fix2-price' },
    body: { paymentMethod: 'online', expectedTotalPaise: res.body.details.charges.grandTotal },
  }), 201);
  assert.equal(placed.order.charges.grandTotal, res.body.details.charges.grandTotal);
});

// ── 10. body-parser errors ───────────────────────────────────────────────────

const rawPost = (path, body) =>
  new Promise((resolve, reject) => {
    const r = http.request(`${srv.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h.customer } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    r.end(body);
  });

test('malformed JSON is a 400 and an oversized body a 413, not a 500', async () => {
  const bad = await rawPost('/api/orders/checkout', '{bad');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_JSON');
  const big = await rawPost('/api/orders/checkout', JSON.stringify({ deliveryInstructions: 'x'.repeat(200_000) }));
  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'PAYLOAD_TOO_LARGE');
});

// ── 11. Socket server without Redis ──────────────────────────────────────────

test('the socket server\'s background jobs run without Redis (no crash)', async () => {
  const { initSocket } = await import('../socket.js');
  const server = http.createServer();
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    initSocket(server, { backgroundJobs: true });
    mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    mock.timers.reset();
    process.off('unhandledRejection', onUnhandled);
    server.close();
  }
  assert.deepEqual(unhandled, []);
});

test('owner pending inbox: each order carries its own approval deadline (from payment for online orders)', async () => {
  const now = Date.now();
  const base = { restaurantId: restaurant._id, type: 'delivery', status: 'placed', items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }], subtotal: 300 };
  const online = await Order.create({ ...base, paymentMethod: 'online', paymentStatus: 'pending' });
  await Order.collection.updateOne({ _id: online._id }, { $set: { createdAt: new Date(now - 10 * MIN) } });
  await Order.updateOne({ _id: online._id }, { $set: { paymentStatus: 'paid' } });
  const { paidAt } = await Order.findById(online._id).lean();

  const data = ok(await req('GET', `/api/owner/${restaurant._id}/orders/pending`, { headers: h.owner }));
  const row = data.orders.find((o) => String(o._id) === String(online._id));
  assert.equal(new Date(row.approvalExpiresAt).getTime(), paidAt.getTime() + data.approvalTimeoutMinutes * MIN);
});

test('owner dashboard and live monitor work without Redis (live numbers read as 0)', async () => {
  const kpis = ok(await req('GET', `/api/owner/${restaurant._id}/dashboard`, { headers: h.owner }));
  assert.equal(kpis.kpis?.liveCount ?? kpis.liveCount, 0);
  const stats = ok(await req('GET', `/api/owner/${restaurant._id}/live-monitor`, { headers: h.owner }));
  assert.equal(stats.stats?.activeVisitors ?? stats.activeVisitors, 0);
});
