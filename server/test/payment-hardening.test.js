// B1 — the payment path refuses fake or wrong money. Runs with a fake Razorpay client (never
// the real gateway), an in-memory MongoDB, simulation OFF and COD OFF.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  webhookSignature,
  paymentCapturedEvent,
  seedBasics,
  createPendingOnlineOrder,
  NEARBY_DROP,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { default: Order } = await import('../models/Order.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');

let mongo;
let srv;
let fake;
let seed;

before(async () => {
  mongo = await startMemoryMongo();
  await WebhookEvent.init();
  srv = await startTestServer({ withSocket: true });
});

after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics();
});

const auth = () => ({ authorization: `Bearer ${seed.customerToken}` });

const verify = (order, paymentId, { signature, razorpayOrderId } = {}) => {
  const rzpOrderId = razorpayOrderId ?? order.paymentIntentId;
  return srv.request('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: auth(),
    body: {
      razorpay_payment_id: paymentId,
      razorpay_order_id: rzpOrderId,
      razorpay_signature: signature ?? checkoutSignature(rzpOrderId, paymentId),
    },
  });
};

const sendWebhook = (event, { eventId = `evt_${Math.random()}`, signature } = {}) => {
  const raw = JSON.stringify(event);
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: {
      'x-razorpay-signature': signature ?? webhookSignature(raw),
      'x-razorpay-event-id': eventId,
    },
  });
};

// ── Client verify: signature ──────────────────────────────────────────────────

test('verify: valid signature + captured, correct amount → paid, fee/tax/channel stored', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_ok', order_id: order.paymentIntentId, amount: 35700, fee: 843, tax: 129 });

  const res = await verify(order, 'pay_ok');
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.paymentChannel, 'online');
  assert.equal(saved.razorpayPaymentId, 'pay_ok');
  assert.equal(saved.razorpayFee, 843);
  assert.equal(saved.razorpayTax, 129);
  assert.equal(fake.calls.capture.length, 0, 'already captured — no capture call');
});

test('verify: tampered signature → 400, order marked failed, gateway never asked', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_x', order_id: order.paymentIntentId, amount: 35700 });

  const res = await verify(order, 'pay_x', { signature: 'deadbeef'.repeat(8) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PAYMENT_VERIFICATION_FAILED');
  assert.equal(fake.calls.fetch.length, 0);

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'failed');
});

test('verify: payment for a different Razorpay order id → 400, order untouched', async () => {
  const order = await createPendingOnlineOrder(seed);
  const res = await verify(order, 'pay_other', { razorpayOrderId: 'order_someone_else' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'pending');
});

// ── Client verify: the money itself ───────────────────────────────────────────

test('verify: captured but for the wrong amount → not paid, flagged for refund', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_short', order_id: order.paymentIntentId, amount: 100 });

  const res = await verify(order, 'pay_short');
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'PAYMENT_VERIFICATION_FAILED');

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'failed');
  assert.equal(saved.refundStatus, 'pending');
  assert.equal(saved.razorpayPaymentId, 'pay_short', 'kept so the refund can be issued against it');
  assert.match(saved.paymentFailureReason, /does not match/);
});

test('verify: wrong currency → refused', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_usd', order_id: order.paymentIntentId, amount: 35700, currency: 'USD' });

  const res = await verify(order, 'pay_usd');
  assert.equal(res.status, 400);
  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.notEqual(saved.paymentStatus, 'paid');
});

test('verify: authorized payment is captured for exactly the order amount', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_auth', order_id: order.paymentIntentId, amount: 35700, status: 'authorized' });

  const res = await verify(order, 'pay_auth');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(fake.calls.capture, [{ id: 'pay_auth', amount: 35700, currency: 'INR' }]);

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.ok(saved.razorpayFee > 0, 'fee taken from the captured payment');
});

test('verify: gateway unreachable → 502, order left pending for the webhook to settle', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_net', order_id: order.paymentIntentId, amount: 35700 });
  fake.failNextFetch(new Error('ECONNRESET'));

  const res = await verify(order, 'pay_net');
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_ERROR');
  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'pending');
});

// ── Webhook ───────────────────────────────────────────────────────────────────

test('webhook: bad signature → 400 and nothing recorded', async () => {
  const res = await sendWebhook({ event: 'payment.captured' }, { signature: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_SIGNATURE');
  assert.equal(await WebhookEvent.countDocuments(), 0);
});

test('webhook: payment.captured settles the order; the same event id twice is processed once', async () => {
  const order = await createPendingOnlineOrder(seed);
  const payment = fake.addPayment({ id: 'pay_wh', order_id: order.paymentIntentId, amount: 35700, fee: 900, tax: 137 });
  const event = paymentCapturedEvent(payment);

  const first = await sendWebhook(event, { eventId: 'evt_same' });
  const second = await sendWebhook(event, { eventId: 'evt_same' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.message, 'Already processed');
  assert.equal(fake.calls.fetch.length, 1, 'payment fetched once — second delivery skipped');

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.razorpayFee, 900);

  const rows = await WebhookEvent.find({ eventId: 'evt_same' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'processed');
});

test('webhook: order.paid is handled like payment.captured', async () => {
  const order = await createPendingOnlineOrder(seed);
  const payment = fake.addPayment({ id: 'pay_op', order_id: order.paymentIntentId, amount: 35700 });
  const res = await sendWebhook(paymentCapturedEvent(payment, 'order.paid'));
  assert.equal(res.status, 200);
  assert.equal((await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean()).paymentStatus, 'paid');
});

test('webhook: wrong amount is refused even though Razorpay signed the event', async () => {
  const order = await createPendingOnlineOrder(seed);
  const payment = fake.addPayment({ id: 'pay_wh_short', order_id: order.paymentIntentId, amount: 500 });
  const res = await sendWebhook(paymentCapturedEvent(payment));
  assert.equal(res.status, 200);

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.paymentStatus, 'failed');
  assert.equal(saved.refundStatus, 'pending');
});

test('webhook: unknown Razorpay order → 200 and recorded as processed', async () => {
  const payment = fake.addPayment({ id: 'pay_ghost', order_id: 'order_nobody', amount: 100 });
  const res = await sendWebhook(paymentCapturedEvent(payment), { eventId: 'evt_ghost' });
  assert.equal(res.status, 200);
  assert.equal((await WebhookEvent.findOne({ eventId: 'evt_ghost' }).lean()).status, 'processed');
});

test('webhook: payment.failed fails a pending order but never undoes a paid one', async () => {
  const pending = await createPendingOnlineOrder(seed);
  const failed = { id: 'pay_f', order_id: pending.paymentIntentId, amount: 35700, status: 'failed', error_description: 'Card declined' };
  await sendWebhook(paymentCapturedEvent(failed, 'payment.failed'));
  const p = await Order.findById(pending._id).lean();
  assert.equal(p.paymentStatus, 'failed');
  assert.equal(p.paymentFailureReason, 'Card declined');

  const paid = await createPendingOnlineOrder(seed, { paymentStatus: 'paid', razorpayPaymentId: 'pay_good' });
  await sendWebhook(paymentCapturedEvent({ ...failed, order_id: paid.paymentIntentId }, 'payment.failed'));
  assert.equal((await Order.findById(paid._id).lean()).paymentStatus, 'paid');
});

test('webhook: transient gateway error → non-2xx so Razorpay retries; the retry succeeds', async () => {
  const order = await createPendingOnlineOrder(seed);
  const payment = fake.addPayment({ id: 'pay_retry', order_id: order.paymentIntentId, amount: 35700 });
  fake.failNextFetch(new Error('socket hang up'));

  const first = await sendWebhook(paymentCapturedEvent(payment), { eventId: 'evt_retry' });
  assert.equal(first.status, 502);
  assert.equal((await WebhookEvent.findOne({ eventId: 'evt_retry' }).lean()).status, 'processing');

  const retry = await sendWebhook(paymentCapturedEvent(payment), { eventId: 'evt_retry' });
  assert.equal(retry.status, 200);
  const row = await WebhookEvent.findOne({ eventId: 'evt_retry' }).lean();
  assert.equal(row.status, 'processed');
  assert.equal(row.attempts, 2);
  assert.equal((await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean()).paymentStatus, 'paid');
});

test('webhook: a refund event with no refund entity is acknowledged and recorded as ignored', async () => {
  const res = await sendWebhook({ event: 'refund.processed', payload: {} }, { eventId: 'evt_refund' });
  assert.equal(res.status, 200);
  assert.equal((await WebhookEvent.findOne({ eventId: 'evt_refund' }).lean()).status, 'ignored');
});

// ── Simulation, COD, gateway availability ─────────────────────────────────────

test('simulate endpoints → 404 when simulation is off', async () => {
  const order = await createPendingOnlineOrder(seed);
  const res = await srv.request('POST', `/api/orders/${order._id}/payment/simulate`, { headers: auth() });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.equal((await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean()).paymentStatus, 'pending');

  const { default: Table } = await import('../models/Table.js');
  const table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T1' });
  const bill = await srv.request(
    'POST',
    `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill/pay/simulate`
  );
  assert.equal(bill.status, 404);
});

test('COD disabled → checkout and raw delivery orders refuse cash with COD_UNAVAILABLE', async () => {
  const checkout = await srv.request('POST', '/api/orders/checkout', {
    headers: auth(),
    body: { paymentMethod: 'cod' },
  });
  assert.equal(checkout.status, 400);
  assert.equal(checkout.body.code, 'COD_UNAVAILABLE');

  const raw = await srv.request('POST', '/api/orders', {
    headers: auth(),
    body: {
      restaurantId: String(seed.restaurant._id),
      items: [{ menuItemId: String(seed.dish._id), quantity: 1 }],
      type: 'delivery',
      paymentMethod: 'cash',
    },
  });
  assert.equal(raw.status, 400);
  assert.equal(raw.body.code, 'COD_UNAVAILABLE');
  assert.equal(await Order.countDocuments(), 0, 'no order left behind');
});

test('no gateway configured → online orders fail closed with 503 and nothing is created', async () => {
  __setRazorpayForTests(null);
  const res = await srv.request('POST', '/api/orders', {
    headers: auth(),
    body: {
      restaurantId: String(seed.restaurant._id),
      items: [{ menuItemId: String(seed.dish._id), quantity: 1 }],
      type: 'delivery',
      paymentMethod: 'online',
    },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
  assert.equal(await Order.countDocuments(), 0);
});

test('raw POST /api/orders is priced like checkout and Razorpay is asked for the full total', async () => {
  const res = await srv.request('POST', '/api/orders', {
    headers: auth(),
    body: {
      restaurantId: String(seed.restaurant._id),
      items: [{ menuItemId: String(seed.dish._id), quantity: 1 }],
      type: 'delivery',
      deliveryAddress: { street: '1 Test Road', city: 'Bengaluru', coordinates: NEARBY_DROP },
      paymentMethod: 'online',
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const saved = await Order.findById(res.body.data.order._id).lean();
  // Priced by the same engine as checkout (charges.service.js): food + 5 % GST + per-km
  // delivery incl. GST + ₹12 platform fee, rounded to the rupee.
  assert.ok(saved.charges, 'breakdown frozen on the order');
  assert.equal(saved.tax, 15);
  assert.equal(saved.platformFee, 12);
  assert.ok(saved.deliveryFee > 0);
  assert.equal(saved.grandTotal, saved.charges.grandTotal / 100);
  assert.equal(saved.paymentChannel, 'online');

  assert.equal(fake.calls.ordersCreate.length, 1);
  assert.equal(fake.calls.ordersCreate[0].amount, Math.round(saved.grandTotal * 100));
  assert.equal(saved.paymentAmountPaise, fake.calls.ordersCreate[0].amount);
  assert.equal(saved.paymentIntentId, res.body.data.razorpayOrder.id);
});

test('GET /api/app/config reports both payment switches', async () => {
  const res = await srv.get('/api/app/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.config.payments.codEnabled, false);
  assert.equal(res.body.data.config.payments.paymentSimulationEnabled, false);
});

// ── Checkout page ─────────────────────────────────────────────────────────────

test('checkout.html runs under a strict CSP and loads its logic from /checkout.js', async () => {
  const page = await srv.get('/checkout.html');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.doesNotMatch(csp.split(';').find((d) => d.includes('script-src')), /unsafe-inline/);
  assert.match(page.body, /<script src="\/checkout\.js"><\/script>/);
  assert.doesNotMatch(page.body, /<script>/, 'no inline script left');

  const script = await srv.get('/checkout.js');
  assert.equal(script.status, 200);
  assert.match(script.body, /new Razorpay\(/);
});
