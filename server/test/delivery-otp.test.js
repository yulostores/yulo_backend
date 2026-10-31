// Delivery codes: the rider's pickup creates a 4-digit code that only the customer sees, the rider
// can't mark the order delivered without it (and is locked out after too many wrong codes), the
// restaurant can no longer close a delivery a rider is carrying, and Yulo support can close it
// instead. In-memory MongoDB, fake Razorpay.
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

const DELIVERY_OTP_MAX_ATTEMPTS = 5;
const customerOrder = async (orderId) => ok(await srv.get(`/api/orders/${orderId}`, h.customer)).order;
const tracking = async (orderId) => ok(await srv.get(`/api/orders/${orderId}/tracking`, h.customer));
const storedCode = async (orderId) =>
  (await Order.findById(orderId).select('+deliveryAssignment.deliveryOtp').lean()).deliveryAssignment.deliveryOtp;
const pickedUp = async () => {
  const { orderId, otp } = await assignedOrder('ready');
  ok(await pickup(orderId, otp));
  return orderId;
};

test('pickup creates a delivery code that only the customer sees, and only while it is on its way', async () => {
  const { orderId, otp } = await assignedOrder('ready');
  assert.equal(await storedCode(orderId), null, 'no code before the rider has the food');
  assert.equal((await customerOrder(orderId)).deliveryAssignment.deliveryOtp, null);

  const picked = ok(await pickup(orderId, otp));
  const code = await storedCode(orderId);
  assert.match(code, /^\d{4}$/);
  assert.equal(JSON.stringify(picked).includes(`"deliveryOtp":"${code}"`), false, 'not in the rider\'s pickup response');

  assert.equal((await customerOrder(orderId)).deliveryAssignment.deliveryOtp, code);
  assert.equal((await tracking(orderId)).deliveryOtp, code);

  // Nobody else's view carries it.
  const riderView = JSON.stringify(await current());
  assert.equal(riderView.includes(code) && riderView.includes('deliveryOtp'), false, 'not on the rider\'s screen');
  const ownerView = JSON.stringify(ok(await srv.get(`/api/owner/${restaurant._id}/orders/${orderId}`, h.owner)));
  assert.equal(ownerView.includes('deliveryOtp'), false, 'not in the restaurant\'s order view');
});

test('the rider needs the customer\'s code to mark the order delivered', async () => {
  const orderId = await pickedUp();
  const code = await storedCode(orderId);

  let res = await deliver(orderId);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'DELIVERY_OTP_REQUIRED');

  const wrong = code === '0000' ? '1111' : '0000';
  res = await deliver(orderId, { otp: wrong });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_OTP');
  assert.match(res.body.message, /4 tries left/);
  assert.equal((await Order.findById(orderId).lean()).status, 'out_for_delivery', 'still on its way');

  ok(await deliver(orderId, { otp: code }));
  const order = await Order.findById(orderId).lean();
  assert.equal(order.status, 'delivered');
  assert.equal(order.deliveryAssignment.status, 'delivered');
  assert.ok(order.deliveryAssignment.deliveryOtpVerifiedAt);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId, type: 'order_earning' }), 1, 'the restaurant is credited');
  assert.equal((await customerOrder(orderId)).deliveryAssignment.deliveryOtp, null, 'code gone once delivered');
});

test('too many wrong codes lock the rider out — even the right code is then refused', async () => {
  const orderId = await pickedUp();
  const code = await storedCode(orderId);
  const wrong = code === '0000' ? '1111' : '0000';
  for (let i = 1; i < DELIVERY_OTP_MAX_ATTEMPTS; i += 1) {
    assert.equal((await deliver(orderId, { otp: wrong })).body.code, 'INVALID_OTP');
  }
  const last = await deliver(orderId, { otp: wrong });
  assert.equal(last.status, 423);
  assert.equal(last.body.code, 'DELIVERY_OTP_LOCKED');
  const right = await deliver(orderId, { otp: code });
  assert.equal(right.status, 423);
  assert.equal((await Order.findById(orderId).lean()).status, 'out_for_delivery');
});

test('the restaurant cannot close a delivery the rider is carrying', async () => {
  const orderId = await pickedUp();
  const res = await chef(orderId, 'delivered');
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'RIDER_CONFIRMS_DELIVERY');
  assert.equal((await Order.findById(orderId).lean()).status, 'out_for_delivery');
});

test('support closes a delivery the rider could not: reason required, logged, credited once', async () => {
  const orderId = await pickedUp();
  const path = `/api/admin/orders/${orderId}/mark-delivered`;

  assert.equal((await req('PATCH', path, { headers: h.admin, body: {} })).status, 400, 'needs a reason');
  assert.equal((await req('PATCH', path, { headers: h.owner, body: { reason: 'Customer phone off' } })).status, 403);

  ok(await req('PATCH', path, { headers: h.admin, body: { reason: 'Customer phone off, left with security' } }));
  const order = await Order.findById(orderId).lean();
  assert.equal(order.status, 'delivered');
  assert.equal(order.deliveryAssignment.status, 'delivered');
  assert.equal(order.statusHistory.at(-1).byRole, 'admin');
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId, type: 'order_earning' }), 1);
  const log = await AdminActivityLog.findOne({ action: 'ORDER_MARKED_DELIVERED' }).lean();
  assert.equal(log.metadata.reason, 'Customer phone off, left with security');

  const again = await req('PATCH', path, { headers: h.admin, body: { reason: 'twice' } });
  assert.equal(again.status, 409);
  assert.equal((await deliver(orderId, { otp: '1234' })).status, 400, 'the rider can no longer deliver it');
});

test('support cannot "deliver" an order the rider has not collected', async () => {
  const { orderId } = await assignedOrder('ready');
  const res = await req('PATCH', `/api/admin/orders/${orderId}/mark-delivered`, { headers: h.admin, body: { reason: 'test' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ORDER_NOT_DELIVERABLE');
});

test('an order collected before delivery codes existed is still delivered without one', async () => {
  const orderId = await pickedUp();
  await Order.updateOne({ _id: orderId }, { $set: { 'deliveryAssignment.deliveryOtp': null } });
  ok(await deliver(orderId));
  assert.equal((await Order.findById(orderId).lean()).status, 'delivered');
});
