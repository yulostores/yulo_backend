// Regression tests for the payment bug-hunt fixes: stale bill amounts, races between payment and
// cancel / retry / counter settlement, payments that can't be counted (duplicates, late ones on a
// settled bill), refund retry and recovery, internal fields leaking into responses, and the
// public bill view. Fake Razorpay, in-memory MongoDB.

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
const billViewService = await import('../services/billView.service.js');
const refundService = await import('../services/refund.service.js');
const { publicBillView } = await import('../utils/publicMask.js');
const { generateTokens } = await import('../services/auth.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: User } = await import('../models/User.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');

let mongo;
let srv;
let fake;
let seed;
let table;
let session;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([WebhookEvent.init(), StrayPayment.init(), RestaurantLedgerEntry.init()]);
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
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T4' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  await addRound(300);
});

const addRound = async (price, sessionId = session._id) => {
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: sessionId,
    tableId: table._id,
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price, quantity: 1 }],
    subtotal: price,
    status: 'served',
  });
  await TableSession.updateOne({ _id: sessionId }, { $push: { orders: order._id } });
  return order;
};

const auth = () => ({ authorization: `Bearer ${seed.customerToken}` });
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
const startBillPayment = async () => {
  const res = await srv.request('POST', `${billBase()}/pay`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.razorpayOrder;
};

// ── Bills ─────────────────────────────────────────────────────────────────────

test('a payment for a stale bill amount is refused after the bill grows', async () => {
  const rzo = await startBillPayment();
  assert.equal((await srv.request('POST', `${billBase()}/cancel`)).status, 200);
  await addRound(500);
  const grown = await srv.get(billBase());
  assert.ok(grown.body.data.bill.grandTotal > rzo.amount / 100, 'bill re-priced upwards');

  fake.addPayment({ id: 'pay_old', order_id: rzo.id, amount: rzo.amount });
  const res = await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_old') });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.status, 'open');
  assert.equal(bill.paymentAmountPaise, null, 'the stale amount was retired');
  assert.equal(bill.refund.status, 'pending');
  assert.equal(bill.refund.amountPaise, rzo.amount);
});

test('a bill being paid is not re-priced (GST toggled mid-payment); the paid total is what is booked', async () => {
  const rzo = await startBillPayment();
  await Restaurant.updateOne({ _id: seed.restaurant._id }, { $set: { gstRegistered: false } });

  const during = await srv.get(billBase());
  assert.equal(during.body.data.bill.grandTotal * 100, rzo.amount, 'frozen while paying');

  fake.addPayment({ id: 'pay_ok', order_id: rzo.id, amount: rzo.amount, fee: 700, tax: 107 });
  const res = await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_ok') });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const entry = await RestaurantLedgerEntry.findOne({ type: 'dine_in_earning' }).lean();
  assert.equal(entry.breakdown.customerPaid, rzo.amount, 'booked at what the guest paid');
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.grandTotal * 100, rzo.amount);
});

test('online and counter settlement at the same moment: one wins, one ledger row', async () => {
  const bill = await billingService.assembleBill(session._id);
  const args = { billId: bill._id, restaurantId: seed.restaurant._id };
  const results = await Promise.allSettled([
    billingService.markPaid({ ...args, paymentMethod: 'online', payment: { via: 'simulation' } }),
    billingService.markPaid({ ...args, paymentMethod: 'cash' }),
    billingService.markPaid({ ...args, paymentMethod: 'upi' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'BILL_ALREADY_PAID');
  assert.equal(await RestaurantLedgerEntry.countDocuments({ billId: bill._id }), 1);
});

test('a late online payment on a bill settled at the counter is recorded as owed back', async () => {
  const rzo = await startBillPayment();
  const bill = await Bill.findOne({ tableSessionId: session._id });
  await billingService.markPaid({ billId: bill._id, restaurantId: seed.restaurant._id, paymentMethod: 'cash' });

  const payment = fake.addPayment({ id: 'pay_late', order_id: rzo.id, amount: rzo.amount });
  const res = await sendWebhook(paymentCapturedEvent(payment), 'evt_late');
  assert.equal(res.status, 200);
  const stray = await StrayPayment.findOne({ razorpayPaymentId: 'pay_late' }).lean();
  assert.equal(stray.kind, 'bill_already_settled');
  assert.equal(stray.refund.status, 'pending');
  assert.equal(stray.amountPaise, rzo.amount);

  // The guest's own verify for the same payment says so, and records it once.
  const v = await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_late') });
  assert.equal(v.status, 409);
  assert.equal(await StrayPayment.countDocuments({ razorpayPaymentId: 'pay_late' }), 1);

  // Listed for the admin and refundable.
  const admin = await User.create({ name: 'A', email: 'a@test.local', role: 'admin' });
  const headers = { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` };
  const list = await srv.get('/api/admin/finance/refunds?status=pending', headers);
  const row = list.body.data.refunds.find((r) => r.source === 'stray_payment');
  assert.ok(row, JSON.stringify(list.body));
  const retry = await srv.request('POST', `/api/admin/finance/refunds/${row._id}/retry`, { headers });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(fake.calls.refund.map((c) => [c.paymentId, c.amount]), [['pay_late', rzo.amount]]);
});

test('webhook: a bill settlement error other than "already paid" is not swallowed', async () => {
  const rzo = await startBillPayment();
  const payment = fake.addPayment({ id: 'pay_gone', order_id: rzo.id, amount: rzo.amount });
  const fetch = fake.payments.fetch;
  fake.payments.fetch = async (id) => {
    const p = await fetch(id);
    await Bill.updateOne({ tableSessionId: session._id }, { $set: { restaurantId: seed.dish._id } });
    return p;
  };
  const res = await sendWebhook(paymentCapturedEvent(payment), 'evt_err');
  fake.payments.fetch = fetch;
  assert.equal(res.status, 200);
  assert.equal((await WebhookEvent.findOne({ eventId: 'evt_err' }).lean()).status, 'failed');
});

test('bill views never carry financials or Razorpay fees; the public view is an allow-list', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_v', order_id: rzo.id, amount: rzo.amount, fee: 700, tax: 107 });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_v') });
  await Bill.updateOne({ tableSessionId: session._id }, { $set: { waiterName: 'Ravi', paymentFailureReason: 'x', 'refund.failureReason': 'internal' } });

  const doc = await Bill.findOne({ tableSessionId: session._id }).select('+financials +razorpayFee +razorpayTax');
  assert.ok(doc.financials, 'the ledger wrote a snapshot');
  const view = await billViewService.buildBillView(doc);
  for (const key of ['financials', 'razorpayFee', 'razorpayTax']) assert.equal(key in view, false, key);

  const pub = publicBillView(view);
  for (const key of ['waiterName', 'waiterId', 'paymentFailureReason', 'paymentIntentHistory', 'razorpayPaymentId', 'customerId', 'customerPhone', 'customerName', 'waiter']) {
    assert.equal(key in pub, false, key);
  }
  assert.ok(pub.batches.every((b) => !('staffName' in b) && !('staffId' in b) && !('staff' in b)));
  assert.equal(pub.refund?.failureReason, undefined);
  assert.equal(pub.grandTotal, view.grandTotal);
});

test('bill payment status: never an older party\'s bill unless asked by its Razorpay order', async () => {
  const rzo = await startBillPayment();
  const bill = await Bill.findOne({ tableSessionId: session._id });
  await billingService.markPaid({ billId: bill._id, restaurantId: seed.restaurant._id, paymentMethod: 'cash' });

  const fresh = await srv.get(`${billBase()}/payment`);
  assert.equal(fresh.body.data.bill.paid, true, 'just closed — still shown');

  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await Bill.updateOne({ _id: bill._id }, { $set: { closedAt: longAgo } });
  await TableSession.updateOne({ _id: session._id }, { $set: { closedAt: longAgo } });
  assert.equal((await srv.get(`${billBase()}/payment`)).body.data.bill, null);
  const named = await srv.get(`${billBase()}/payment?razorpayOrderId=${rzo.id}`);
  assert.equal(named.body.data.bill.paid, true);
});

// ── Orders ────────────────────────────────────────────────────────────────────

test('a payment racing a customer cancel is refunded', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_r1', order_id: order.paymentIntentId, amount: 35700 });
  // The customer cancels while verify is asking Razorpay about the payment.
  let cancel;
  const fetch = fake.payments.fetch;
  fake.payments.fetch = async (id) => {
    cancel = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: auth(), body: {} });
    return fetch(id);
  };
  const verify = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: auth(),
    body: verifyBody(order.paymentIntentId, 'pay_r1'),
  });
  fake.payments.fetch = fetch;

  assert.equal(cancel.status, 200);
  assert.equal(verify.status, 200);
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.status, 'cancelled');
  assert.equal(fake.calls.refund.length, 1, 'refunded');
  assert.equal(saved.refund.status, 'processing');
});

test('retry racing a webhook never puts a paid order back to pending', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'failed' });
  const rzo = await fake.orders.create({ amount: 35700, currency: 'INR' });
  await Order.updateOne({ _id: order._id }, { paymentIntentId: rzo.id, paymentIntentHistory: [rzo.id] });
  // The payment lands (webhook) while retry is asking Razorpay about the old order.
  const ofetch = fake.orders.fetch;
  fake.orders.fetch = async (id) => {
    const payment = fake.addPayment({ id: 'pay_r2', order_id: rzo.id, amount: 35700 });
    const hook = await sendWebhook(paymentCapturedEvent(payment), 'evt_r2');
    assert.equal(hook.status, 200);
    return ofetch(id);
  };
  const retry = await srv.request('POST', `/api/orders/${order._id}/payment/retry`, { headers: auth() });
  fake.orders.fetch = ofetch;

  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.razorpayPaymentId, 'pay_r2');
});

test('verify with a second payment on a paid order: refused, not overwritten, owed back', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_1', order_id: order.paymentIntentId, amount: 35700, fee: 840, tax: 128 });
  const first = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, { headers: auth(), body: verifyBody(order.paymentIntentId, 'pay_1') });
  assert.equal(first.status, 200);
  for (const key of ['razorpayFee', 'razorpayTax', 'financials']) assert.equal(key in first.body.data.order, false, key);

  fake.addPayment({ id: 'pay_2', order_id: order.paymentIntentId, amount: 35700 });
  const second = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, { headers: auth(), body: verifyBody(order.paymentIntentId, 'pay_2') });
  assert.equal(second.status, 409);
  const saved = await Order.findById(order._id).select('+razorpayFee').lean();
  assert.equal(saved.razorpayPaymentId, 'pay_1');
  assert.equal(saved.razorpayFee, 840);
  assert.equal(fake.calls.capture.length, 0);
  const stray = await StrayPayment.findOne({ razorpayPaymentId: 'pay_2' }).lean();
  assert.equal(stray.kind, 'duplicate_payment');
});

test('a refused payment flag survives a later valid payment', async () => {
  const order = await createPendingOnlineOrder(seed);
  fake.addPayment({ id: 'pay_short', order_id: order.paymentIntentId, amount: 100 });
  const bad = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, { headers: auth(), body: verifyBody(order.paymentIntentId, 'pay_short') });
  assert.equal(bad.status, 400);

  fake.addPayment({ id: 'pay_good', order_id: order.paymentIntentId, amount: 35700 });
  const good = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, { headers: auth(), body: verifyBody(order.paymentIntentId, 'pay_good') });
  assert.equal(good.status, 200, JSON.stringify(good.body));

  const saved = await Order.findById(order._id).lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.refund.status, 'none');
  const stray = await StrayPayment.findOne({ razorpayPaymentId: 'pay_short' }).lean();
  assert.equal(stray.kind, 'refused_payment');
  assert.equal(stray.refund.amountPaise, 100);
});

test('payment.failed and a bad-signature verify never downgrade a refunded order', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'refunded', razorpayPaymentId: 'pay_x', refund: { status: 'processed' } });
  const failed = fake.addPayment({ id: 'pay_f', order_id: order.paymentIntentId, amount: 35700, status: 'failed' });
  await sendWebhook(paymentCapturedEvent(failed, 'payment.failed'), 'evt_f');
  await srv.request('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: auth(),
    body: { ...verifyBody(order.paymentIntentId, 'pay_f'), razorpay_signature: 'bad' },
  });
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'refunded');
});

// ── Refunds ───────────────────────────────────────────────────────────────────

test('a refund that crashes after being claimed is marked failed, and a stuck one is retryable', async () => {
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'paid', razorpayPaymentId: 'pay_c', status: 'cancelled', cancelledBy: 'restaurant' });
  __setRazorpayForTests({ ...fake, payments: { ...fake.payments, refund: async () => null } });
  const crashed = await refundService.initiateFullRefund(order._id, { reason: 'test', cause: 'restaurant_reject' });
  assert.equal(crashed.refund.status, 'failed');
  __setRazorpayForTests(fake);

  // Stuck: claimed long ago, never answered.
  await Order.updateOne({ _id: order._id }, { $set: { 'refund.status': 'processing', 'refund.razorpayRefundId': null, 'refund.initiatedAt': new Date(Date.now() - 60 * 60 * 1000) } });
  const { source, doc } = await refundService.retryRefund(order._id, 'admin');
  assert.equal(source, 'order');
  assert.equal(doc.refund.status, 'processing');
  assert.ok(doc.refund.razorpayRefundId);
  assert.equal(fake.calls.refund.length, 1);

  // A fresh 'processing' one is not.
  await assert.rejects(refundService.retryRefund(order._id, 'admin'), (e) => e.code === 'REFUND_NOT_RETRYABLE');
});

test('a refused bill payment is listed and refundable by the admin', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_wrong', order_id: rzo.id, amount: 100 });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_wrong') });
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.refund.status, 'pending');

  const { refunds } = await refundService.listRefunds({ status: 'pending', page: 1, limit: 20 });
  assert.ok(refunds.some((r) => r.source === 'bill' && String(r._id) === String(bill._id)));
  const { source, doc } = await refundService.retryRefund(bill._id, 'admin');
  assert.equal(source, 'bill');
  assert.equal(doc.refund.status, 'processing');
  assert.deepEqual(fake.calls.refund.map((c) => [c.paymentId, c.amount]), [['pay_wrong', 100]]);

  // Razorpay's refund.processed webhook closes it.
  await sendWebhook({ event: 'refund.processed', payload: { refund: { entity: { id: doc.refund.razorpayRefundId, payment_id: 'pay_wrong' } } } }, 'evt_rp');
  assert.equal((await Bill.findById(bill._id).lean()).refund.status, 'processed');
});

test('a dine-in round cancelled after the bill was paid online is flagged for the admin', async () => {
  const rzo = await startBillPayment();
  fake.addPayment({ id: 'pay_dine', order_id: rzo.id, amount: rzo.amount });
  await srv.request('POST', `${billBase()}/verify`, { body: verifyBody(rzo.id, 'pay_dine') });
  const round = await Order.findOne({ tableSessionId: session._id });
  assert.equal(round.paymentStatus, 'paid');

  await Order.updateOne({ _id: round._id }, { $set: { status: 'cancelled' } });
  await refundService.onOrderCancelled(await Order.findById(round._id).lean(), { previousStatus: 'served', actorRole: 'owner' });
  const stray = await StrayPayment.findOne({ kind: 'dine_in_round_cancelled' }).lean();
  assert.equal(String(stray.orderId), String(round._id));
  assert.equal(stray.razorpayPaymentId, 'pay_dine');
  assert.equal(stray.amountPaise, null);
  await assert.rejects(refundService.retryRefund(stray._id, 'admin'), (e) => e.code === 'REFUND_AMOUNT_UNKNOWN');
});
