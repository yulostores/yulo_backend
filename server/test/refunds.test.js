// B5 — refunds and the cancellation rules, against a fake Razorpay and an in-memory MongoDB:
// every row of the refund table, who bears Razorpay's fee, idempotency, refund webhooks, the
// admin list/retry, the customer's no-refund confirmation and what the customer is shown.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  webhookSignature,
  paymentCapturedEvent,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache, createVersion } = await import('../services/financeSettings.service.js');
const refundService = await import('../services/refund.service.js');
const kitchenService = await import('../services/kitchen.service.js');
const orderApproval = await import('../services/orderApproval.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let fake;
let restaurant;
let owner;
let customer;
let admin;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), WebhookEvent.init()]);
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
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  customer = await User.create({ name: 'Asha', phone: '9876543210', role: 'customer' });
  admin = await User.create({ name: 'Admin', email: 'a@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    isActive: true,
    approvalStatus: 'active',
  });
});

const customerHeaders = () => ({ authorization: `Bearer ${generateTokens(customer._id, 'customer').accessToken}` });
const adminHeaders = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });

// An online order that has been paid: ₹357 captured, Razorpay kept ₹11.38 of it.
const paidOrder = (fields = {}) =>
  Order.create({
    restaurantId: restaurant._id,
    userId: customer._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 357,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    paymentIntentId: `order_rzp_${Math.random().toString(36).slice(2, 9)}`,
    paymentAmountPaise: 35700,
    razorpayPaymentId: `pay_${Math.random().toString(36).slice(2, 9)}`,
    razorpayFee: 1138,
    razorpayTax: 174,
    status: 'placed',
    ...fields,
  });

const feeDebit = (orderId) => RestaurantLedgerEntry.findOne({ orderId, type: 'refund_gateway_fee' }).lean();

// ── The refund table ──────────────────────────────────────────────────────────

test('restaurant rejects a paid order → full refund; restaurant debited Razorpay\'s fee incl. GST', async () => {
  const order = await paidOrder();
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Too busy' });

  assert.equal(fake.calls.refund.length, 1);
  assert.equal(fake.calls.refund[0].paymentId, order.razorpayPaymentId);
  assert.equal(fake.calls.refund[0].amount, 35700, 'the full captured amount');
  assert.equal(fake.calls.refund[0].speed, 'normal');

  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.status, 'processing');
  assert.equal(saved.refund.cause, 'restaurant_reject');
  assert.equal(saved.refund.feeBorneBy, 'restaurant');
  assert.equal(saved.refund.razorpayRefundId, 'rfnd_fake_1');
  assert.equal(saved.refundStatus, 'pending', 'legacy field in step');

  const debit = await feeDebit(order._id);
  assert.equal(debit.direction, 'debit');
  assert.equal(debit.amountPaise, 1138, 'Razorpay fee + its GST, as Razorpay reported it');
});

test('approval timeout → full refund, cause approval_timeout', async () => {
  const order = await paidOrder({ createdAt: new Date(Date.now() - 60 * 60 * 1000) });
  await orderApproval.expireUnansweredOrders();
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.refund.cause, 'approval_timeout');
  assert.equal(fake.calls.refund.length, 1);
  assert.ok(await feeDebit(order._id));
});

test('kitchen cancels after accepting → full refund, cause restaurant_cancel_after_accept', async () => {
  const order = await paidOrder({ status: 'preparing' });
  await kitchenService.updateOrderStatus({
    orderId: order._id,
    currentStatus: 'preparing',
    newStatus: 'cancelled',
    actor: { role: 'chef' },
    reason: 'Ran out of paneer',
  });
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.cause, 'restaurant_cancel_after_accept');
  assert.equal(fake.calls.refund.length, 1);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id, type: 'order_earning' }), 0);
});

test('customer cancels before the restaurant accepts → full refund; fee bearer follows the setting', async () => {
  await createVersion(
    { patch: { refundFeeBorneBy: { customer_cancel_before_accept: 'platform' } } },
    admin._id
  );
  const order = await paidOrder();
  const res = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: customerHeaders(), body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.order.refund.status, 'processing');
  assert.match(res.body.data.order.refund.timeline, /5–7 business days/);

  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.cause, 'customer_cancel_before_accept');
  assert.equal(saved.refund.feeBorneBy, 'platform');
  assert.equal(await feeDebit(order._id), null, 'the platform bears it — no restaurant debit');
});

test('customer cancels after accept but before the kitchen starts → full refund', async () => {
  const order = await paidOrder({ status: 'confirmed' });
  const res = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: customerHeaders(), body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fake.calls.refund.length, 1);
});

test('customer cancels after preparation started: 400 without confirmation; with it, no refund and the restaurant is paid', async () => {
  const order = await paidOrder({
    status: 'preparing',
    charges: {
      food: { subtotal: 30000, discount: 0, base: 30000, gstPercent: 5, gst: 1500, total: 31500 },
      delivery: { pending: false, distanceKm: 1, base: 2542, gst: 458, total: 3000, paidBy: 'customer', customerPays: 3000 },
      platformFee: { count: 1, base: 1017, gst: 183, total: 1200 },
      tip: 0,
      roundOff: 0,
      grandTotal: 35700,
    },
  });

  const refused = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: customerHeaders(), body: {} });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await Order.findById(order._id).lean()).status, 'preparing');

  const ok = await srv.request('POST', `/api/orders/${order._id}/cancel`, {
    headers: customerHeaders(),
    body: { confirmNoRefund: true },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.order.status, 'cancelled');
  assert.equal(ok.body.data.order.refund, null);
  assert.equal(fake.calls.refund.length, 0, 'no refund');

  const credit = await RestaurantLedgerEntry.findOne({ orderId: order._id, type: 'order_earning' }).lean();
  assert.equal(credit.amountPaise, 30250, 'the restaurant is paid as for a delivered order');
});

test('customer cannot cancel once the food is on its way', async () => {
  const order = await paidOrder({ status: 'out_for_delivery' });
  const res = await srv.request('POST', `/api/orders/${order._id}/cancel`, {
    headers: customerHeaders(),
    body: { confirmNoRefund: true },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ORDER_NOT_CANCELLABLE');
});

test('nothing to refund: cash-on-delivery and unpaid online orders', async () => {
  const cod = await paidOrder({ paymentMethod: 'cash', paymentChannel: 'cod', paymentStatus: 'pending_cod', razorpayPaymentId: null });
  const unpaid = await paidOrder({ paymentStatus: 'pending', razorpayPaymentId: null });
  for (const order of [cod, unpaid]) {
    await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Closed' });
  }
  assert.equal(fake.calls.refund.length, 0);
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 0);
});

test('a payment that lands after the order was cancelled is refunded in full', async () => {
  const order = await paidOrder({
    paymentStatus: 'pending',
    razorpayPaymentId: null,
    razorpayFee: null,
    razorpayTax: null,
  });
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Closed' });
  assert.equal(fake.calls.refund.length, 0, 'not paid yet — nothing to refund');

  const payment = fake.addPayment({ id: 'pay_late', order_id: order.paymentIntentId, amount: 35700, fee: 900, tax: 137 });
  const raw = JSON.stringify(paymentCapturedEvent(payment));
  const res = await srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': 'evt_late' },
  });
  assert.equal(res.status, 200);

  assert.equal(fake.calls.refund.length, 1);
  assert.equal(fake.calls.refund[0].paymentId, 'pay_late');
  const saved = await Order.findById(order._id).lean();
  // Rejected while still unpaid, paid afterwards: the restaurant had nothing payable to act on,
  // so the platform bears Razorpay's fee (round 2 — was restaurant_reject / restaurant-borne).
  assert.equal(saved.refund.cause, 'paid_after_cancel');
  assert.equal(saved.refund.feeBorneBy, 'platform');
  assert.equal(await feeDebit(order._id), null);
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test('double cancel / simultaneous refund requests → exactly one refund call and one fee debit', async () => {
  const order = await paidOrder();
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Busy' });
  await assert.rejects(
    orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Busy' })
  );
  await Promise.all(
    [1, 2, 3].map(() =>
      refundService.initiateFullRefund(order._id, { reason: 'again', cause: 'restaurant_reject' })
    )
  );
  assert.equal(fake.calls.refund.length, 1);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id, type: 'refund_gateway_fee' }), 1);
});

// ── Refund webhooks ───────────────────────────────────────────────────────────

const refundEvent = (type, refund) => {
  const raw = JSON.stringify({ event: type, payload: { refund: { entity: refund } } });
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': `evt_${type}_${refund.id}` },
  });
};

test('refund.processed webhook → processed; paymentStatus refunded; legacy refundStatus refunded', async () => {
  const order = await paidOrder();
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Busy' });

  const res = await refundEvent('refund.processed', { id: 'rfnd_fake_1', payment_id: order.razorpayPaymentId, amount: 35700 });
  assert.equal(res.status, 200);
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.status, 'processed');
  assert.ok(saved.refund.processedAt);
  assert.equal(saved.paymentStatus, 'refunded');
  assert.equal(saved.refundStatus, 'refunded');

  const view = await srv.get(`/api/orders/${order._id}`, customerHeaders());
  assert.equal(view.body.data.order.refund.status, 'processed');
  assert.equal(view.body.data.order.refund.amount, 357);
  assert.match(view.body.data.order.refund.timeline, /refunded to your original payment method/);
});

test('refund.failed webhook → failed (flagged for admin); a later processed one still wins', async () => {
  const order = await paidOrder();
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Busy' });
  await refundEvent('refund.failed', { id: 'rfnd_fake_1', payment_id: order.razorpayPaymentId, error_description: 'Bank declined' });
  let saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.status, 'failed');
  assert.equal(saved.refund.failureReason, 'Bank declined');

  await refundEvent('refund.processed', { id: 'rfnd_fake_1', payment_id: order.razorpayPaymentId });
  saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.status, 'processed');
});

// ── Admin ─────────────────────────────────────────────────────────────────────

test('gateway refuses the refund → failed; admin lists it, retries it, and it goes through', async () => {
  const order = await paidOrder();
  fake.failNextRefund({ statusCode: 400, error: { description: 'Insufficient balance' } });
  await orderApproval.rejectOrder({ restaurantId: restaurant._id, orderId: order._id, user: owner, reason: 'Busy' });
  assert.equal((await Order.findById(order._id).lean()).refund.status, 'failed');

  const list = await srv.get('/api/admin/finance/refunds?status=failed', adminHeaders());
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.refunds[0].refund.failureReason, 'Insufficient balance');

  fake.refundsReturn('processed');
  const retry = await srv.request('POST', `/api/admin/finance/refunds/${order._id}/retry`, { headers: adminHeaders() });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.data.refund.status, 'processed');
  assert.equal(fake.calls.refund.length, 2);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id, type: 'refund_gateway_fee' }), 1, 'fee debited once, not per attempt');

  const again = await srv.request('POST', `/api/admin/finance/refunds/${order._id}/retry`, { headers: adminHeaders() });
  assert.equal(again.status, 409);

  const asCustomer = await srv.get('/api/admin/finance/refunds', customerHeaders());
  assert.equal(asCustomer.status, 403);
});

test('partial refunds after preparation are not configurable yet', async () => {
  await assert.rejects(
    createVersion({ patch: { customerCancelAfterPreparationRefundPercent: 50 } }, admin._id),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

// ── Round-2 cause fixes ───────────────────────────────────────────────────────

test('customer cancels an accepted order before cooking: its own cause, the before-accept fee rule', async () => {
  await createVersion({ patch: { refundFeeBorneBy: { customer_cancel_before_accept: 'platform' } } }, admin._id);
  const order = await paidOrder({ status: 'confirmed', acceptedAt: new Date() });
  const res = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: customerHeaders(), body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.cause, 'customer_cancel_before_preparation');
  assert.equal(saved.refund.feeBorneBy, 'platform', 'follows customer_cancel_before_accept');
  assert.equal(await feeDebit(order._id), null);
});

test('a payment landing on an order cancelled while unpaid: refunded, the platform bears the fee', async () => {
  const cancelledAt = new Date(Date.now() - 5 * 60 * 1000);
  const order = await paidOrder({
    status: 'cancelled',
    cancelledBy: 'system',
    cancelledAt,
    paidAt: new Date(),
  });
  assert.equal(await refundService.refundIfCancelled(await Order.findById(order._id).lean()), true);

  const saved = await Order.findById(order._id).lean();
  assert.equal(fake.calls.refund.length, 1);
  assert.equal(saved.refund.cause, 'paid_after_cancel');
  assert.equal(saved.refund.feeBorneBy, 'platform');
  assert.equal(await feeDebit(order._id), null, 'no restaurant debit for an order it never could act on');
});
