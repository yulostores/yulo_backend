// B6 — the payment APIs the apps need: retrying a payment (reusing the Razorpay order when it
// can), polling payment status, counter payments by waiter/owner, never reopening a table that
// is mid-payment, masked public payloads, and atomic Idempotency-Key handling. Fake Razorpay,
// in-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  webhookSignature,
  paymentCapturedEvent,
  checkoutSignature,
  seedBasics,
  NEARBY_DROP,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: User } = await import('../models/User.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { generateTokens, generateStaffToken } = await import('../services/auth.service.js');

let mongo;
let srv;
let fake;
let seed;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([IdempotencyKey.init(), WebhookEvent.init(), RestaurantLedgerEntry.init()]);
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
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics();
});

const customer = () => ({ authorization: `Bearer ${seed.customerToken}` });
const webhook = (payment, eventId) => {
  const raw = JSON.stringify(paymentCapturedEvent(payment));
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': eventId },
  });
};

const placeOnlineOrder = async () => {
  const res = await srv.request('POST', '/api/orders', {
    headers: customer(),
    body: {
      restaurantId: String(seed.restaurant._id),
      items: [{ menuItemId: String(seed.dish._id), quantity: 1 }],
      type: 'delivery',
      deliveryAddress: { coordinates: NEARBY_DROP },
      paymentMethod: 'online',
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return Order.findById(res.body.data.order._id);
};

// ── Order: retry & poll ───────────────────────────────────────────────────────

test('retry reuses the Razorpay order while it can still be paid — same amount, no new order', async () => {
  const order = await placeOnlineOrder();
  const res = await srv.request('POST', `/api/orders/${order._id}/payment/retry`, { headers: customer() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.reused, true);
  assert.equal(res.body.data.razorpayOrder.id, order.paymentIntentId);
  assert.equal(res.body.data.razorpayOrder.amount, order.paymentAmountPaise);
  assert.equal(fake.calls.ordersCreate.length, 1, 'only the original');
});

test('retry creates a new Razorpay order for the same frozen amount when the old one is done; a late payment on the old one still counts', async () => {
  const order = await placeOnlineOrder();
  const firstIntent = order.paymentIntentId;
  fake.setOrderStatus(firstIntent, 'paid'); // e.g. expired/closed on Razorpay's side, no live payment

  const res = await srv.request('POST', `/api/orders/${order._id}/payment/retry`, { headers: customer() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.reused, false);
  assert.notEqual(res.body.data.razorpayOrder.id, firstIntent);
  assert.equal(fake.calls.ordersCreate[1].amount, order.paymentAmountPaise, 'same frozen amount');

  const saved = await Order.findById(order._id).lean();
  assert.deepEqual(saved.paymentIntentHistory, [firstIntent, res.body.data.razorpayOrder.id]);

  const late = fake.addPayment({ id: 'pay_late', order_id: firstIntent, amount: order.paymentAmountPaise });
  await webhook(late, 'evt_late_old_intent');
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'paid');
});

test('retry refuses while a payment is already captured (settling) — no second Razorpay order', async () => {
  const order = await placeOnlineOrder();
  fake.addPayment({ id: 'pay_settling', order_id: order.paymentIntentId, amount: order.paymentAmountPaise });
  const res = await srv.request('POST', `/api/orders/${order._id}/payment/retry`, { headers: customer() });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'PAYMENT_ALREADY_RECEIVED');
  assert.equal(fake.calls.ordersCreate.length, 1);
});

test('retry on a paid or cancelled order → 409', async () => {
  const paid = await placeOnlineOrder();
  await Order.updateOne({ _id: paid._id }, { $set: { paymentStatus: 'paid' } });
  assert.equal((await srv.request('POST', `/api/orders/${paid._id}/payment/retry`, { headers: customer() })).body.code, 'ALREADY_PAID');

  const cancelled = await placeOnlineOrder();
  await Order.updateOne({ _id: cancelled._id }, { $set: { status: 'cancelled' } });
  const res = await srv.request('POST', `/api/orders/${cancelled._id}/payment/retry`, { headers: customer() });
  assert.equal(res.status, 409);
});

test('payment poll: pending → paid by webhook, confirmedVia says so', async () => {
  const order = await placeOnlineOrder();
  const before = await srv.get(`/api/orders/${order._id}/payment`, customer());
  assert.equal(before.status, 200);
  assert.equal(before.body.data.paymentStatus, 'pending');
  assert.equal(before.body.data.paid, false);
  assert.equal(before.body.data.canRetry, true);

  const payment = fake.addPayment({ id: 'pay_poll', order_id: order.paymentIntentId, amount: order.paymentAmountPaise });
  await webhook(payment, 'evt_poll');

  const afterRes = await srv.get(`/api/orders/${order._id}/payment`, customer());
  assert.equal(afterRes.body.data.paid, true);
  assert.equal(afterRes.body.data.confirmedVia, 'webhook');
  assert.equal(afterRes.body.data.canRetry, false);
  assert.equal(afterRes.body.data.refund, null);
});

// ── Dine-in bill ──────────────────────────────────────────────────────────────

let table;
let session;
const seatAndServe = async ({ guestName = 'Asha Rao', guestPhone = '9876543210' } = {}) => {
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T7' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id, guestName, guestPhone });
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    type: 'dine_in',
    placedBy: 'guest',
    customerName: guestName,
    customerPhone: guestPhone,
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
};
const billBase = () => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill`;

test('bill pay twice (or via /pay/retry) → the same Razorpay order, created once', async () => {
  await seatAndServe();
  const first = await srv.request('POST', `${billBase()}/pay`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await srv.request('POST', `${billBase()}/pay/retry`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.reused, true);
  assert.equal(again.body.data.razorpayOrder.id, first.body.data.razorpayOrder.id);
  assert.equal(fake.calls.ordersCreate.length, 1);
});

test('bill cancel is refused while a payment is captured; allowed when the checkout was just abandoned', async () => {
  await seatAndServe();
  const { razorpayOrder } = (await srv.request('POST', `${billBase()}/pay`)).body.data;

  const abandoned = await srv.request('POST', `${billBase()}/cancel`);
  assert.equal(abandoned.status, 200);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open', 'reopened');

  await srv.request('POST', `${billBase()}/pay`);
  fake.addPayment({ id: 'pay_mid', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  const refused = await srv.request('POST', `${billBase()}/cancel`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'PAYMENT_IN_PROGRESS');
  assert.equal((await TableSession.findById(session._id).lean()).status, 'bill_requested', 'still locked');
});

test('bill verify after the webhook already settled it → 200, not 404; bill payment poll reports it', async () => {
  await seatAndServe();
  const { razorpayOrder } = (await srv.request('POST', `${billBase()}/pay`)).body.data;
  const payment = fake.addPayment({ id: 'pay_b', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  await webhook(payment, 'evt_bill_first');

  const verify = await srv.request('POST', `${billBase()}/verify`, {
    body: {
      razorpay_payment_id: 'pay_b',
      razorpay_order_id: razorpayOrder.id,
      razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_b'),
    },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));

  const poll = await srv.get(`${billBase()}/payment`);
  assert.equal(poll.body.data.bill.paid, true);
  assert.equal(poll.body.data.bill.confirmedVia, 'webhook');
  assert.equal(poll.body.data.bill.paymentChannel, 'online');
});

// ── Counter payments ──────────────────────────────────────────────────────────

const waiterHeaders = async () => {
  const waiter = await StaffMember.create({
    restaurantId: seed.restaurant._id,
    staffCode: 'W01',
    name: 'Ravi',
    role: 'waiter',
    phone: '9000000099',
  });
  return { authorization: `Bearer ${generateStaffToken(waiter._id, 'waiter', seed.restaurant._id, 0)}` };
};
const markPaidUrl = () => `/api/staff/${seed.restaurant._id}/waiter/sessions/${session._id}/bill/mark-paid`;

test('waiter marks cash → counter payment, ₹12.42 debit; "online" is not a counter method', async () => {
  await seatAndServe();
  const headers = await waiterHeaders();
  await srv.get(`/api/staff/${seed.restaurant._id}/waiter/sessions/${session._id}/bill`, headers);

  const online = await srv.request('POST', markPaidUrl(), { headers, body: { method: 'online' } });
  assert.equal(online.status, 400);

  const res = await srv.request('POST', markPaidUrl(), { headers, body: { method: 'cash' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.paymentChannel, 'counter');
  assert.equal(bill.paidBy, 'cash');
  const debit = await RestaurantLedgerEntry.findOne({ billId: bill._id }).lean();
  assert.equal(debit.type, 'counter_platform_fee');
  assert.equal(debit.amountPaise, 1242);
});

test('a bill the guest paid online cannot be re-marked cash (409); nor while their payment is captured', async () => {
  await seatAndServe();
  const headers = await waiterHeaders();
  const { razorpayOrder } = (await srv.request('POST', `${billBase()}/pay`)).body.data;
  fake.addPayment({ id: 'pay_guest', order_id: razorpayOrder.id, amount: razorpayOrder.amount });

  const midPayment = await srv.request('POST', markPaidUrl(), { headers, body: { method: 'cash' } });
  assert.equal(midPayment.status, 409);
  assert.equal(midPayment.body.code, 'PAID_ONLINE');

  const payment = fake.addPayment({ id: 'pay_guest', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  await webhook(payment, 'evt_guest_paid');
  const after = await srv.request('POST', markPaidUrl(), { headers, body: { method: 'cash' } });
  assert.equal(after.status, 409);
  assert.equal(after.body.code, 'BILL_ALREADY_PAID');
  const entries = await RestaurantLedgerEntry.find({}).lean();
  assert.deepEqual(entries.map((e) => e.type), ['dine_in_earning'], 'credited once, never debited');
});

test('owner can mark a dine-in bill paid by UPI at the counter', async () => {
  await seatAndServe();
  const { default: billing } = { default: await import('../services/billing.service.js') };
  const bill = await billing.assembleBill(session._id);
  const owner = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  const res = await srv.request('POST', `/api/owner/${seed.restaurant._id}/bills/${bill._id}/mark-paid`, {
    headers: owner,
    body: { method: 'upi' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await Bill.findById(bill._id).lean()).paymentChannel, 'counter');
  assert.equal((await RestaurantLedgerEntry.findOne({ billId: bill._id }).lean()).amountPaise, 1242);
});

// ── Masking ───────────────────────────────────────────────────────────────────

test('public session and bill never expose other diners\' names, phones or internal ids', async () => {
  await seatAndServe();
  const sessionRes = await srv.get(`/api/restaurants/${seed.restaurant._id}/tables/${table._id}/session`);
  const s = sessionRes.body.data.session;
  assert.equal(s.guestName, 'A.');
  assert.equal(s.guestPhone, '******3210');
  assert.ok(!('waiterId' in s));
  for (const o of s.orders) {
    assert.equal(o.customerName, 'A.');
    assert.equal(o.customerPhone, '******3210');
    assert.ok(!('userId' in o) && !('staffId' in o));
  }
  assert.doesNotMatch(JSON.stringify(sessionRes.body), /9876543210|Asha Rao/);

  const billRes = await srv.get(billBase());
  assert.equal(billRes.status, 200);
  assert.equal(billRes.body.data.bill.customer.name, 'A.');
  assert.equal(billRes.body.data.bill.customer.phone, '******3210');
  assert.doesNotMatch(JSON.stringify(billRes.body), /9876543210|Asha Rao/);
});

// ── Idempotency ───────────────────────────────────────────────────────────────

const guestOrder = (key) =>
  srv.request('POST', `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/orders`, {
    headers: key ? { 'Idempotency-Key': key } : {},
    body: { items: [{ menuItemId: String(seed.dish._id), quantity: 1 }] },
  });

test('guest order: the same Idempotency-Key (sequential or simultaneous) creates one order', async () => {
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T9' });

  const first = await guestOrder('cart-abc');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const repeat = await guestOrder('cart-abc');
  assert.equal(repeat.status, 200);
  assert.equal(String(repeat.body.data.order.orderId), String(first.body.data.order._id));

  const racers = await Promise.all([guestOrder('cart-xyz'), guestOrder('cart-xyz'), guestOrder('cart-xyz')]);
  assert.equal(racers.filter((r) => r.status === 201).length, 1, 'exactly one created');
  for (const r of racers) assert.ok([200, 201, 409].includes(r.status));

  assert.equal(await Order.countDocuments({ type: 'dine_in' }), 2, 'cart-abc and cart-xyz — one order each');
  await guestOrder('cart-new');
  assert.equal(await Order.countDocuments({ type: 'dine_in' }), 3, 'a different key is a different order');
});

test('checkout: a retried request with the same key returns the order instead of "Cart is empty"', async () => {
  await User.updateOne(
    { _id: seed.customer._id },
    { $set: { savedAddresses: [{ street: '1 Road', city: 'Bengaluru', location: { type: 'Point', coordinates: NEARBY_DROP }, isDefault: true }] } }
  );
  await Cart.create({
    userId: seed.customer._id,
    restaurantId: seed.restaurant._id,
    items: [{ menuItemId: seed.dish._id, name: 'Thali', unitPrice: 300, mrpUnitPrice: 300, qty: 1 }],
  });
  const send = () =>
    srv.request('POST', '/api/orders/checkout', {
      headers: { ...customer(), 'Idempotency-Key': 'checkout-1' },
      body: { paymentMethod: 'online' },
    });
  const first = await send();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await send();
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(String(second.body.data.order.orderId), String(first.body.data.orderId));
  assert.equal(await Order.countDocuments(), 1);
});

// ── Platform-internal money never leaves through customer/owner/public responses ──

test("Razorpay's fee and the settlement breakdown are never in customer, owner or public payloads", async () => {
  const order = await placeOnlineOrder();
  const payment = fake.addPayment({ id: 'pay_int', order_id: order.paymentIntentId, amount: order.paymentAmountPaise, fee: 900, tax: 137 });
  await webhook(payment, 'evt_internal');
  await Order.updateOne({ _id: order._id }, { $set: { status: 'out_for_delivery' } });
  const kitchen = await import('../services/kitchen.service.js');
  await kitchen.updateOrderStatus({ orderId: order._id, currentStatus: 'out_for_delivery', newStatus: 'delivered', actor: { role: 'chef' } });
  assert.ok((await Order.findById(order._id).select('+financials').lean()).financials, 'stored');

  const leaks = /razorpayFee|razorpayTax|yuloSettlementMargin|"financials"/;
  const customerView = await srv.get(`/api/orders/${order._id}`, customer());
  assert.doesNotMatch(JSON.stringify(customerView.body), leaks);
  const customerList = await srv.get('/api/orders', customer());
  assert.doesNotMatch(JSON.stringify(customerList.body), leaks);

  const owner = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  const ownerOrder = await srv.get(`/api/owner/${seed.restaurant._id}/orders/${order._id}`, owner);
  assert.equal(ownerOrder.status, 200, JSON.stringify(ownerOrder.body));
  assert.doesNotMatch(JSON.stringify(ownerOrder.body), leaks);
  const ownerBills = await srv.get(`/api/owner/${seed.restaurant._id}/bills`, owner);
  assert.doesNotMatch(JSON.stringify(ownerBills.body), leaks);

  await seatAndServe();
  const { razorpayOrder } = (await srv.request('POST', `${billBase()}/pay`)).body.data;
  const billPayment = fake.addPayment({ id: 'pay_int_bill', order_id: razorpayOrder.id, amount: razorpayOrder.amount, fee: 700, tax: 107 });
  await webhook(billPayment, 'evt_internal_bill');
  const publicPoll = await srv.get(`${billBase()}/payment`);
  assert.doesNotMatch(JSON.stringify(publicPoll.body), leaks);
});
