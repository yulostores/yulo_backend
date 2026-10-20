// Regression tests for the second payment bug hunt: a refused payment's refund never hijacking the
// real payment, one owed-back record per refused payment, refused payments not locking anyone out
// of paying, late refund webhooks for an older attempt, webhook replays under a new event id,
// forged bill verifies, rounds cancelled while a bill is being paid, abandoned bill payments, and
// refunds owed under the old code. Fake Razorpay, in-memory MongoDB.

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
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const billingService = await import('../services/billing.service.js');
const counterPaymentService = await import('../services/counterPayment.service.js');
const refundService = await import('../services/refund.service.js');
const { generateTokens } = await import('../services/auth.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');

let mongo;
let srv;
let fake;
let seed;
let table;
let session;
let firstRound;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([WebhookEvent.init(), StrayPayment.init(), RestaurantLedgerEntry.init(), Bill.init()]);
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  await WebhookEvent.syncIndexes();
  __resetFinanceSettingsCache();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics();
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T7' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  firstRound = await addRound(300);
});

const addRound = async (price) => {
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price, quantity: 1 }],
    subtotal: price,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
  return order;
};

const auth = () => ({ authorization: `Bearer ${seed.customerToken}` });
const ownerAuth = () => ({ authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` });
const billBase = () => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill`;
const verifyBody = (rzpOrderId, paymentId) => ({
  razorpay_payment_id: paymentId,
  razorpay_order_id: rzpOrderId,
  razorpay_signature: checkoutSignature(rzpOrderId, paymentId),
});
const sendWebhook = (event, eventId) => {
  const raw = JSON.stringify(event);
  return srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': eventId },
  });
};
const refundEvent = (type, entity) => ({ entity: 'event', event: type, payload: { refund: { entity } }, created_at: Math.floor(Date.now() / 1000) });
const verifyOrder = (order, paymentId) =>
  srv.request('POST', `/api/orders/${order._id}/payment/verify`, { headers: auth(), body: verifyBody(order.paymentIntentId, paymentId) });
const startBillPayment = async () => {
  const res = await srv.request('POST', `${billBase()}/pay`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.razorpayOrder;
};
const owedBackFor = async (paymentId) => {
  const strays = await StrayPayment.countDocuments({ razorpayPaymentId: paymentId, kind: { $ne: 'dine_in_round_cancelled' } });
  const flaggedOrders = await Order.countDocuments({ razorpayPaymentId: paymentId, 'refund.status': { $nin: ['none', null] } });
  const flaggedBills = await Bill.countDocuments({ razorpayPaymentId: paymentId, 'refund.status': { $nin: ['none', null] } });
  return strays + flaggedOrders + flaggedBills;
};

// ── 1. A refund in flight for a refused payment never hijacks the real payment ───────────────

test('a refused payment\'s refund in flight moves off the order when the real payment lands', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_short', order_id: order.paymentIntentId, amount: 100 });
  assert.equal((await verifyOrder(order, 'pay_short')).status, 400);
  // The admin sends the refused payment back: in flight with Razorpay.
  const { doc: inFlight } = await refundService.retryRefund(order._id, 'admin');
  assert.equal(inFlight.refund.status, 'processing');
  const shortRefundId = inFlight.refund.razorpayRefundId;

  fake.addPayment({ id: 'pay_good', order_id: order.paymentIntentId, amount: 35700 });
  assert.equal((await verifyOrder(order, 'pay_good')).status, 200);
  let saved = await Order.findById(order._id).lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.razorpayPaymentId, 'pay_good');
  assert.equal(saved.refund.status, 'none', 'the order\'s refund slot is free for its real payment');
  const stray = await StrayPayment.findOne({ razorpayPaymentId: 'pay_short' }).lean();
  assert.equal(stray.refund.status, 'processing');
  assert.equal(stray.refund.razorpayRefundId, shortRefundId);

  // The restaurant rejects: the REAL payment is refunded in full.
  await Order.updateOne({ _id: order._id }, { $set: { status: 'cancelled', cancelledBy: 'restaurant' } });
  await refundService.initiateFullRefund(order._id, { reason: 'Rejected', cause: 'restaurant_reject' });
  assert.deepEqual(fake.calls.refund.map((c) => [c.paymentId, c.amount]), [['pay_short', 100], ['pay_good', 35700]]);

  // pay_short's refund completes: it closes the stray, not the order.
  await sendWebhook(refundEvent('refund.processed', { id: shortRefundId, payment_id: 'pay_short' }), 'evt_short_done');
  assert.equal((await StrayPayment.findById(stray._id).lean()).refund.status, 'processed');
  saved = await Order.findById(order._id).lean();
  assert.equal(saved.paymentStatus, 'paid', 'not marked refunded by another payment\'s refund');
  assert.equal(saved.refund.status, 'processing');

  // pay_good's own refund completes: now it is refunded.
  await sendWebhook(refundEvent('refund.processed', { id: saved.refund.razorpayRefundId, payment_id: 'pay_good' }), 'evt_good_done');
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'refunded');
});

test('a refused bill payment\'s failed refund moves off the bill when the real payment settles it', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_bshort', order_id: rzo.id, amount: 100 });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_bshort') });
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  await Bill.updateOne({ _id: bill._id }, { $set: { 'refund.status': 'failed', 'refund.razorpayRefundId': 'rfnd_old' } });

  const again = await startBillPayment();
  fake.addPayment({ id: 'pay_bgood', order_id: again.id, amount: again.amount });
  const ok = await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(again.id, 'pay_bgood') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const paid = await Bill.findById(bill._id).lean();
  assert.equal(paid.status, 'paid');
  assert.equal(paid.refund.status, 'none');
  const stray = await StrayPayment.findOne({ razorpayPaymentId: 'pay_bshort' }).lean();
  assert.equal(stray.refund.status, 'failed');
  assert.equal(String(stray.billId), String(bill._id));
});

// ── 2. One owed-back record per refused payment ──────────────────────────────────────────────

test('a refused order payment seen by verify and both webhook events is owed back once', async () => {
  const order = await createPendingOnlineOrder(seed);
  const payment = fake.addPayment({ id: 'pay_once', order_id: order.paymentIntentId, amount: 100 });
  assert.equal((await verifyOrder(order, 'pay_once')).status, 400);
  await sendWebhook(paymentCapturedEvent(payment), 'evt_once_1');
  await sendWebhook(paymentCapturedEvent(payment, 'order.paid'), 'evt_once_2');
  assert.equal(await owedBackFor('pay_once'), 1);
  const { refunds } = await refundService.listRefunds({ status: 'pending', page: 1, limit: 20 });
  assert.equal(refunds.length, 1);
});

test('a refused bill payment seen by verify and the webhook is owed back once', async () => {
  const rzo = await startBillPayment();
  const payment = fake.addPayment({ id: 'pay_bonce', order_id: rzo.id, amount: 100 });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_bonce') });
  await sendWebhook(paymentCapturedEvent(payment), 'evt_bonce');
  assert.equal(await owedBackFor('pay_bonce'), 1);
});

// ── 3. A refused payment doesn't lock anyone out of paying ───────────────────────────────────

test('after a refused payment the customer can retry paying the order', async () => {
  const order = await createPendingOnlineOrder(seed);
  const rzo = await fake.orders.create({ amount: 35700, currency: 'INR' });
  await Order.updateOne({ _id: order._id }, { paymentIntentId: rzo.id, paymentIntentHistory: [rzo.id] });
  fake.addPayment({ id: 'pay_wrong', order_id: rzo.id, amount: 100 });
  assert.equal((await verifyOrder({ ...order.toObject(), paymentIntentId: rzo.id }, 'pay_wrong')).status, 400);

  const status = await srv.get(`/api/orders/${order._id}/payment`, auth());
  assert.equal(status.body.data.canRetry, true);
  const retry = await srv.request('POST', `/api/orders/${order._id}/payment/retry`, { headers: auth() });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.ok(retry.body.data.razorpayOrder.id);
});

test('after a refused bill payment the guest can pay again and staff can settle at the counter', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_bwrong', order_id: rzo.id, amount: 100 });
  assert.equal((await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_bwrong') })).status, 400);

  const again = await srv.request('POST', `${billBase()}/pay`);
  assert.equal(again.status, 200, JSON.stringify(again.body));

  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  const settled = await counterPaymentService.markPaidAtCounter({ billId: bill._id, restaurantId: seed.restaurant._id, method: 'cash' });
  assert.equal(settled.status, 'paid');
  assert.equal(settled.paymentChannel, 'counter');
});

test('a captured payment that can still settle the bill keeps blocking the counter', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_live', order_id: rzo.id, amount: rzo.amount });
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  await assert.rejects(
    counterPaymentService.markPaidAtCounter({ billId: bill._id, restaurantId: seed.restaurant._id, method: 'cash' }),
    (e) => e.code === 'PAID_ONLINE'
  );
});

// ── 4. A late refund.failed for an older attempt never undoes the retried refund ─────────────

test('a late refund.failed for a replaced refund id is ignored — no second refund', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'paid', razorpayPaymentId: 'pay_rf', status: 'cancelled', cancelledBy: 'restaurant' });
  const first = await refundService.initiateFullRefund(order._id, { reason: 'Rejected', cause: 'restaurant_reject' });
  const oldId = first.refund.razorpayRefundId;
  await sendWebhook(refundEvent('refund.failed', { id: oldId, payment_id: 'pay_rf', error_description: 'bank down' }), 'evt_rf_1');
  assert.equal((await Order.findById(order._id).lean()).refund.status, 'failed');

  const { doc: retried } = await refundService.retryRefund(order._id, 'admin');
  assert.equal(retried.refund.status, 'processing');
  const newId = retried.refund.razorpayRefundId;

  // Razorpay redelivers the old failure later, under a new event id.
  await sendWebhook(refundEvent('refund.failed', { id: oldId, payment_id: 'pay_rf', error_description: 'old failure' }), 'evt_rf_2');
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.refund.status, 'processing');
  assert.equal(saved.refund.razorpayRefundId, newId);
  await assert.rejects(refundService.retryRefund(order._id, 'admin'), (e) => e.code === 'REFUND_NOT_RETRYABLE');
  assert.equal(fake.calls.refund.length, 2);
});

test('a refund event created before the attempt in flight started does not match it', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'paid', razorpayPaymentId: 'pay_old', status: 'cancelled' });
  await Order.updateOne({ _id: order._id }, {
    $set: { 'refund.status': 'processing', 'refund.razorpayRefundId': null, 'refund.initiatedAt': new Date(), 'refund.amountPaise': 35700 },
  });
  const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
  await sendWebhook(refundEvent('refund.failed', { id: 'rfnd_ancient', payment_id: 'pay_old', created_at: anHourAgo }), 'evt_ancient');
  assert.equal((await Order.findById(order._id).lean()).refund.status, 'processing');
});

// ── 5. Webhook replays ───────────────────────────────────────────────────────────────────────

test('a signed webhook body replayed under a new event id is not processed again', async () => {
  const order = await createPendingOnlineOrder(seed);
  const failed = fake.addPayment({ id: 'pay_fl', order_id: order.paymentIntentId, amount: 35700, status: 'failed' });
  const event = paymentCapturedEvent(failed, 'payment.failed');
  assert.equal((await sendWebhook(event, 'evt_fail_1')).status, 200);
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'failed');

  // The customer retries (same Razorpay order reused) — then the old body is replayed.
  await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'pending', paymentFailureReason: null } });
  const replay = await sendWebhook(event, 'evt_fail_forged');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.message, 'Already processed');
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
});

test('payment.failed for a Razorpay order the order has moved on from is ignored', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentIntentHistory: ['order_old_one'] });
  const failed = fake.addPayment({ id: 'pay_oldfail', order_id: 'order_old_one', amount: 35700, status: 'failed' });
  await sendWebhook(paymentCapturedEvent(failed, 'payment.failed'), 'evt_oldfail');
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
});

// ── 6. A forged bill verify never reopens a table being paid ─────────────────────────────────

test('a bad-signature bill verify leaves the table locked for the guest who is paying', async () => {
  const rzo = await startBillPayment();
  const forged = await srv.request('POST', `${billBase()}/verify`, {
    body: { razorpay_order_id: rzo.id, razorpay_payment_id: 'pay_forged', razorpay_signature: 'deadbeef' },
  });
  assert.equal(forged.status, 400);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'bill_requested');
});

test('a wrong-amount bill payment (checked with Razorpay) still reopens the table', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_amt', order_id: rzo.id, amount: 100 });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_amt') });
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
});

// ── 7. Rounds cancelled while the bill is being paid ─────────────────────────────────────────

test('a round cannot be cancelled while its bill is being paid online', async () => {
  const second = await addRound(200);
  await startBillPayment();
  await assert.rejects(billingService.assertRoundCancellable(second), (e) => e.code === 'PAYMENT_IN_PROGRESS');
  // Anything else passes.
  await billingService.assertRoundCancellable(await createPendingOnlineOrder(seed));
});

test('a round voided while held and then paid for is flagged to refund, never marked paid', async () => {
  const second = await addRound(200);
  const rzo = await startBillPayment();
  // Cancelled behind the hold (any path that skips assertRoundCancellable).
  await Order.updateOne({ _id: second._id }, { $set: { status: 'cancelled' } });
  fake.addPayment({ id: 'pay_held', order_id: rzo.id, amount: rzo.amount });
  const ok = await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_held') });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  assert.notEqual((await Order.findById(second._id).lean()).paymentStatus, 'paid');
  assert.equal((await Order.findById(firstRound._id).lean()).paymentStatus, 'paid');
  const flag = await StrayPayment.findOne({ kind: 'dine_in_round_cancelled', orderId: second._id }).lean();
  assert.ok(flag, 'flagged for the admin');
  assert.equal(flag.razorpayPaymentId, 'pay_held');
});

// ── 8. Abandoned bill payments ───────────────────────────────────────────────────────────────

test('a bill held for an abandoned payment is released after the hold expires', async () => {
  await startBillPayment();
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.ok(bill.paymentStartedAt);
  await addRound(150);
  await TableSession.updateOne({ _id: session._id }, { $set: { status: 'bill_requested' } });

  // Still held within the window.
  const held = await billingService.assembleBill(session._id);
  assert.equal(held.subtotal, 300);

  await Bill.updateOne({ _id: bill._id }, { $set: { paymentStartedAt: new Date(Date.now() - billingService.PAYMENT_HOLD_MS - 1000) } });
  const released = await billingService.assembleBill(session._id);
  assert.equal(released.subtotal, 450, 're-priced');
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
});

test('an expired hold stays while a payment that can settle the bill is going through', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_slow', order_id: rzo.id, amount: rzo.amount, status: 'authorized' });
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  await Bill.updateOne({ _id: bill._id }, { $set: { paymentStartedAt: new Date(Date.now() - billingService.PAYMENT_HOLD_MS - 1000) } });
  await billingService.assembleBill(session._id);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'bill_requested');
});

test('owner and waiter can release a held bill; not while a payment is going through', async () => {
  const rzo = await startBillPayment();
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();

  const live = fake.addPayment({ id: 'pay_mid', order_id: rzo.id, amount: rzo.amount, status: 'authorized' });
  const refused = await srv.request('POST', `/api/owner/${seed.restaurant._id}/bills/${bill._id}/release-payment`, { headers: ownerAuth() });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code ?? refused.body.error?.code, 'PAYMENT_IN_PROGRESS');

  live.status = 'failed';
  fake.addPayment(live);
  const released = await srv.request('POST', `/api/owner/${seed.restaurant._id}/bills/${bill._id}/release-payment`, { headers: ownerAuth() });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
  for (const key of ['financials', 'razorpayFee', 'razorpayTax']) assert.equal(key in released.body.data.bill, false, key);
});

// ── 9. Refunds owed under the old code ───────────────────────────────────────────────────────

test('a refund owed under the old code is listed as pending and can be sent', async () => {
  const order = await createPendingOnlineOrder(seed, {
    paymentStatus: 'paid',
    razorpayPaymentId: 'pay_legacy',
    status: 'cancelled',
    cancelledBy: 'restaurant',
    refundStatus: 'pending',
  });
  await Order.collection.updateOne({ _id: order._id }, { $unset: { refund: '' } });

  const { refunds } = await refundService.listRefunds({ status: 'pending', page: 1, limit: 20 });
  const row = refunds.find((r) => String(r._id) === String(order._id));
  assert.ok(row, 'listed');
  assert.equal(row.legacy, true);
  assert.equal(row.refund.amountPaise, 35700);
  assert.ok((await refundService.listRefunds({ page: 1, limit: 20 })).refunds.some((r) => String(r._id) === String(order._id)));

  const { doc } = await refundService.retryRefund(order._id, 'admin');
  assert.equal(doc.refund.status, 'processing');
  assert.equal(doc.refund.feeBorneBy, 'platform');
  assert.deepEqual(fake.calls.refund.map((c) => [c.paymentId, c.amount]), [['pay_legacy', 35700]]);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ type: 'refund_gateway_fee' }), 0, 'never charged to the restaurant');
});
