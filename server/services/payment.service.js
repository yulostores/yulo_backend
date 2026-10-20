import crypto from 'crypto';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import StrayPayment from '../models/StrayPayment.js';
import { env } from '../config/env.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import * as billingService from './billing.service.js';
import { handleRefundWebhook, moveRefundToStray, recordStrayPayment, refundIfCancelled } from './refund.service.js';
import { notifyService } from './notify.service.js';
import { getRazorpay, getRazorpayKeyId } from './razorpayClient.js';
import { toPaise } from '../utils/money.js';

// Rupee amounts in this codebase are plain numbers; Razorpay speaks paise. Rounded once here
// so 357.1 * 100 = 35709.99999 never reaches the gateway or a comparison.
const rupeesToPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);

// What a payment must be for. An order's price is frozen at checkout: paymentAmountPaise is
// stamped when its Razorpay order is created (an order from before that field falls back to
// the figure the old code sent). A dine-in bill is a running tab that can be re-priced until it
// is paid, so a payment is always checked against its total NOW — never against the amount an
// older Razorpay order was made for.
const expectedOrderPaise = (order) => order.paymentAmountPaise ?? rupeesToPaise(order.grandTotal ?? order.subtotal);
const expectedBillPaise = (bill) => toPaise(bill.grandTotal);

const UNCOUNTABLE = ['paid', 'refunded'];

// A payment we will not count against its order/bill. Captured → recorded as a stray payment
// owed back (models/StrayPayment.js). Merely authorized → left uncaptured: Razorpay releases an
// uncaptured authorization back to the customer by itself.
const recordUncountedPayment = async ({ kind, payment, reason, ...refs }) => {
  if (payment?.status === 'captured') {
    await recordStrayPayment({ kind, payment, reason, ...refs });
    return;
  }
  logger.warn({ kind, razorpayPaymentId: payment?.id, status: payment?.status, ...refs }, `Uncounted payment left uncaptured — ${reason}`);
};

// A refused payment flagged on the document's own refund belongs to that payment. When a
// different payment is about to become the document's payment, that refund — owed, in flight,
// done or failed — moves to a stray payment of its own (refund.service.js moveRefundToStray):
// still owed back, and never confused with a refund of the new payment.
const supersedeRefusedFlag = (Model, docId, newPaymentId) => moveRefundToStray(Model, docId, newPaymentId);

// The refused payment is already flagged on this document (verify and the webhook — or the
// payment.captured and order.paid events — each refuse the same payment): nothing more to do.
const alreadyFlagged = async (Model, docId, paymentId) => {
  const current = await Model.findById(docId).select('razorpayPaymentId refund').lean();
  return current?.razorpayPaymentId === paymentId && Boolean(current.refund?.status) && current.refund.status !== 'none';
};

// Razorpay's SDK rejects with a plain object carrying `statusCode` for API errors, and with a
// network Error (no statusCode) when it can't reach Razorpay at all. A 4xx means our request
// was wrong and will be wrong again (permanent); anything else may succeed on a retry. The
// webhook handler uses `transient` to decide whether to ask Razorpay to redeliver.
const gatewayCall = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    const statusCode = err?.statusCode;
    const apiErr = new ApiError(
      502,
      'PAYMENT_GATEWAY_ERROR',
      'The payment gateway could not be reached — please try again'
    );
    apiErr.transient = !(statusCode >= 400 && statusCode < 500);
    logger.error(
      { label, statusCode, gatewayError: err?.error?.description ?? err?.message },
      'Razorpay call failed'
    );
    throw apiErr;
  }
};

// Called before an order/bill commits to online payment. With simulation on, nothing is
// needed; otherwise a configured gateway is required — fail closed rather than let an order
// sit in "awaiting payment" with no way to pay it.
export const assertOnlinePaymentAvailable = () => {
  if (paymentSimulationEnabled) return;
  if (!getRazorpay()) {
    throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Online payment is unavailable right now');
  }
};

// The single place an order becomes paid (client verify, webhook, the dev simulate
// endpoint). Beyond the payment fields, it covers the two approval-flow consequences of a
// payment landing: the owner inbox is told the order can now be accepted, and a payment
// captured on an order that was already cancelled is refunded in full straight away.
//
// Atomic: the paid write only matches an order not already paid/refunded, so a webhook and a
// verify (or two payments) racing each other count one payment; a different payment that loses
// is recorded as a stray payment owed back. The cancellation check reads the order AFTER the
// write, so a cancel racing the payment is always caught by one side: either the cancel sees the
// order paid (and refunds), or this sees it cancelled (and refunds).
//
// `payment` is the Razorpay payment entity when there is one (absent for a simulated
// payment) — its fee/tax are what settlement later charges, so they are kept as received.
// Returns the order as it now stands (a fresh document; the caller's copy is not updated).
export const recordCapturedPayment = async (order, paymentId, payment = null, via = 'verify') => {
  await supersedeRefusedFlag(Order, order._id, paymentId);
  const set = {
    paymentStatus: 'paid',
    paymentChannel: 'online',
    razorpayPaymentId: paymentId,
    paymentFailureReason: null,
    paymentConfirmedVia: via,
  };
  if (payment) {
    set.razorpayFee = payment.fee ?? null;
    set.razorpayTax = payment.tax ?? null;
  }
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $nin: UNCOUNTABLE } },
    { $set: set },
    { new: true }
  );
  if (!updated) {
    const current = await Order.findById(order._id);
    if (current && current.razorpayPaymentId !== paymentId && payment) {
      await recordUncountedPayment({
        kind: 'duplicate_payment',
        payment,
        restaurantId: current.restaurantId,
        orderId: current._id,
        reason: 'A second payment for an order that was already paid',
      });
    }
    return current;
  }

  const result = (await refundIfCancelled(updated)) ? await Order.findById(order._id) : updated;
  notifyService.orderPaymentUpdated(result);
  return result;
};

const hmacHex = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

const timingSafeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

// Shared by controllers/order.controller.js (delivery/takeaway orders) and
// controllers/publicBill.controller.js (dine-in bills) — both just need a Razorpay order
// for some rupee amount against some receipt id, then stamp the returned id and amount onto
// their own document themselves.
//
// Returns null ONLY in simulation mode (the caller then tells the client to use the simulate
// endpoint). Otherwise a missing gateway is a 503 and a gateway failure a 502 — never a
// silent fallback to "unpaid but placed".
export const createRazorpayOrder = async ({ amountRupees, amountPaise: exactPaise, receipt, notes = {} }) => {
  if (paymentSimulationEnabled) return null;
  assertOnlinePaymentAvailable();

  const amountPaise = exactPaise ?? rupeesToPaise(amountRupees);
  const rzpOrder = await gatewayCall('orders.create', () =>
    getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: String(receipt),
      notes,
    })
  );

  return {
    id: rzpOrder.id,
    amount: rzpOrder.amount,
    currency: rzpOrder.currency,
    keyId: getRazorpayKeyId(),
  };
};

// Every Razorpay order id a document has had — the current one plus any a retry replaced.
const intentIdsOf = (doc) => [...new Set([...(doc.paymentIntentHistory ?? []), doc.paymentIntentId].filter(Boolean))];

/**
 * Stamps a (new or reused) Razorpay order onto an Order/Bill document: becomes the current
 * paymentIntentId, joins paymentIntentHistory, and fixes the paise amount payments are checked
 * against. Does not save.
 */
export const adoptRazorpayOrder = (doc, razorpayOrder) => {
  doc.paymentIntentId = razorpayOrder.id;
  doc.paymentAmountPaise = razorpayOrder.amount;
  if (!(doc.paymentIntentHistory ?? []).includes(razorpayOrder.id)) {
    doc.paymentIntentHistory = [...(doc.paymentIntentHistory ?? []), razorpayOrder.id];
  }
};

// A captured payment we have already refused and recorded as owed back — as a stray payment, or
// flagged on an unsettled order/bill's own refund. It will never settle anything.
const isOwedBack = async (paymentId) => {
  const [stray, order, bill] = await Promise.all([
    StrayPayment.exists({ razorpayPaymentId: paymentId, kind: { $ne: 'dine_in_round_cancelled' } }),
    Order.exists({ razorpayPaymentId: paymentId, paymentStatus: { $nin: UNCOUNTABLE }, 'refund.status': { $nin: ['none', null] } }),
    Bill.exists({ razorpayPaymentId: paymentId, status: 'open', 'refund.status': { $nin: ['none', null] } }),
  ]);
  return Boolean(stray || order || bill);
};

/**
 * Whether money has (or may have) moved against any of these Razorpay orders that can still
 * settle the order/bill: a payment that is authorized (will be captured) or captured. Asked
 * before anything that assumes it hasn't — reopening a table whose guest is mid-payment, marking
 * it paid in cash, creating a second Razorpay order. Gateway errors throw (gatewayCall) —
 * "couldn't tell" must never read as "no".
 *
 * Not live: a payment already refused and owed back, and — given `expectedPaise`, the amount
 * the document must be paid — one for a different amount, which would be refused anyway. Such
 * a payment must not lock the customer out of paying properly (or the waiter out of the counter).
 */
export const hasLivePayment = async (razorpayOrderIds, { expectedPaise = null } = {}) => {
  const ids = [].concat(razorpayOrderIds).filter(Boolean);
  if (ids.length === 0) return false;
  const rzp = getRazorpay();
  if (!rzp) return false;
  for (const id of ids) {
    const res = await gatewayCall('orders.fetchPayments', () => rzp.orders.fetchPayments(id));
    for (const p of res?.items ?? []) {
      if (p.status !== 'authorized' && p.status !== 'captured') continue;
      if (expectedPaise != null && p.amount !== expectedPaise) continue;
      if (await isOwedBack(p.id)) continue;
      return true;
    }
  }
  return false;
};

/**
 * The Razorpay order to pay `doc` (an Order or Bill) with, for exactly `amountPaise`: its
 * current one when Razorpay still takes payments on it ('created'/'attempted') for that amount,
 * else a fresh one. Refuses (409 PAYMENT_ALREADY_RECEIVED) when a payment has already gone
 * through on one of its Razorpay orders and is waiting to be settled — a second order would
 * invite paying twice. Returns { razorpayOrder, reused } — or null in dev simulation mode.
 */
export const ensureRazorpayOrder = async (doc, { amountPaise, receipt, notes = {} }) => {
  if (paymentSimulationEnabled) return null;
  assertOnlinePaymentAvailable();
  const rzp = getRazorpay();

  if (await hasLivePayment(intentIdsOf(doc), { expectedPaise: amountPaise })) {
    throw new ApiError(
      409,
      'PAYMENT_ALREADY_RECEIVED',
      'A payment for this has already been received — it will show as paid in a moment'
    );
  }

  if (doc.paymentIntentId) {
    const current = await gatewayCall('orders.fetch', () => rzp.orders.fetch(doc.paymentIntentId));
    if (['created', 'attempted'].includes(current.status) && current.amount === amountPaise) {
      return {
        reused: true,
        razorpayOrder: { id: current.id, amount: current.amount, currency: current.currency, keyId: getRazorpayKeyId() },
      };
    }
  }

  const razorpayOrder = await createRazorpayOrder({ amountPaise, receipt, notes });
  return { reused: false, razorpayOrder };
};

// A valid signature only proves Razorpay saw SOME payment for this Razorpay order id. This
// asks Razorpay what was actually paid, and only accepts it when every one of these holds:
//   - it belongs to the Razorpay order we created for this order/bill
//   - it is in INR
//   - it is for exactly the paise amount we asked Razorpay to collect
//   - it is captured (an `authorized` payment is captured here, for that exact amount)
// Returns { ok: true, payment } or { ok: false, payment, reason } — the caller decides what
// a refusal does to its own document. Gateway errors throw (see gatewayCall).
export const confirmCapturedPayment = async ({ paymentId, razorpayOrderId, expectedPaise }) => {
  const rzp = getRazorpay();
  if (!rzp) {
    throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment verification is not configured');
  }

  let payment = await gatewayCall('payments.fetch', () => rzp.payments.fetch(paymentId));

  const refuse = (reason) => ({ ok: false, payment, reason });
  if (payment.order_id !== razorpayOrderId) return refuse('Payment belongs to a different Razorpay order');
  if (payment.currency !== 'INR') return refuse(`Unexpected currency ${payment.currency}`);
  if (!Number.isInteger(expectedPaise) || payment.amount !== expectedPaise) {
    return refuse(`Paid amount ${payment.amount} paise does not match expected ${expectedPaise} paise`);
  }

  if (payment.status === 'authorized') {
    payment = await gatewayCall('payments.capture', () =>
      rzp.payments.capture(paymentId, expectedPaise, 'INR')
    );
  }
  if (payment.status !== 'captured') return refuse(`Payment is ${payment.status}, not captured`);

  return { ok: true, payment };
};

// A payment we refuse to count against an order. Never downgrades an order that is already
// paid/refunded (another, valid payment may have settled it first) — a captured payment that
// loses that race is a stray payment owed back. When the money was taken from a still-unpaid
// order, the order itself is flagged for a refund of it (admin refunds screen).
const rejectOrderPayment = async (order, { payment, reason }) => {
  if (payment?.id && (await alreadyFlagged(Order, order._id, payment.id))) return;
  logger.error(
    { orderId: order._id, razorpayPaymentId: payment?.id, reason },
    'Razorpay payment refused for order'
  );
  const failed = { paymentStatus: 'failed', paymentFailureReason: reason };
  if (payment?.status !== 'captured') {
    await Order.updateOne({ _id: order._id, paymentStatus: { $nin: UNCOUNTABLE } }, { $set: failed });
    return;
  }
  const flagged = await Order.updateOne(
    { _id: order._id, paymentStatus: { $nin: UNCOUNTABLE }, 'refund.status': { $in: ['none', null] } },
    {
      $set: {
        ...failed,
        razorpayPaymentId: payment.id,
        refundStatus: 'pending',
        'refund.status': 'pending',
        'refund.amountPaise': payment.amount,
        'refund.reason': reason,
      },
    }
  );
  if (flagged.modifiedCount) return;
  // Already paid, or already holding a flag for another refused payment.
  await Order.updateOne({ _id: order._id, paymentStatus: { $nin: UNCOUNTABLE } }, { $set: failed });
  await recordStrayPayment({ kind: 'refused_payment', payment, restaurantId: order.restaurantId, orderId: order._id, reason });
};

const rejectBillPayment = async (bill, { payment, reason }) => {
  if (payment?.id && (await alreadyFlagged(Bill, bill._id, payment.id))) return;
  logger.error(
    { billId: bill._id, razorpayPaymentId: payment?.id, reason },
    'Razorpay payment refused for bill'
  );
  if (payment?.status !== 'captured') {
    await Bill.updateOne({ _id: bill._id, status: 'open' }, { $set: { paymentFailureReason: reason } });
    return;
  }
  const flagged = await Bill.updateOne(
    { _id: bill._id, status: 'open', 'refund.status': { $in: ['none', null] } },
    {
      $set: {
        paymentFailureReason: reason,
        razorpayPaymentId: payment.id,
        refundStatus: 'pending',
        'refund.status': 'pending',
        'refund.amountPaise': payment.amount,
        'refund.reason': reason,
      },
    }
  );
  if (flagged.modifiedCount) return;
  // Settled meanwhile, or already holding a flag for another refused payment.
  await recordStrayPayment({ kind: 'refused_payment', payment, restaurantId: bill.restaurantId, billId: bill._id, reason });
};

// Razorpay's documented client-side verification scheme: HMAC-SHA256 of
// "<order_id>|<payment_id>" using RAZORPAY_KEY_SECRET, compared against what the client
// (which got it straight from Razorpay's Checkout SDK) submitted. Implemented directly
// via Node's crypto rather than reaching into the `razorpay` npm package's own
// verification helper, which isn't part of its documented public API surface.
const assertValidSignature = ({ razorpay_payment_id, razorpay_order_id, razorpay_signature }) => {
  if (!env.RAZORPAY_KEY_SECRET) {
    throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment verification is not configured');
  }
  const expected = hmacHex(`${razorpay_order_id}|${razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
  return timingSafeEqualHex(expected, razorpay_signature);
};

export const verifyOrderPayment = async (order, body) => {
  // order.paymentIntentId was stamped when the Razorpay order was created
  // (controllers/order.controller.js's createRazorpayOrderIfNeeded) — this confirms the
  // payment being verified actually belongs to THIS order, not just any valid signature
  // for a payment made against a different one.
  if (!intentIdsOf(order).includes(body.razorpay_order_id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This payment does not belong to this order');
  }

  if (!assertValidSignature(body)) {
    // A bad signature never downgrades an order that is already paid or refunded (a webhook
    // may have settled it first) — it only fails one that was still waiting.
    await Order.updateOne(
      { _id: order._id, paymentStatus: { $nin: UNCOUNTABLE } },
      { $set: { paymentStatus: 'failed', paymentFailureReason: 'Payment signature verification failed' } }
    );
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment signature verification failed');
  }

  if (UNCOUNTABLE.includes(order.paymentStatus)) {
    // Already settled by this same payment (webhook got here first) — nothing more to check.
    if (order.razorpayPaymentId === body.razorpay_payment_id) return order;
    // A second, different payment: never counted, never captured by us. Owed back if Razorpay
    // already captured it.
    const payment = await gatewayCall('payments.fetch', () => getRazorpay().payments.fetch(body.razorpay_payment_id));
    if (payment.order_id === body.razorpay_order_id) {
      await recordUncountedPayment({
        kind: 'duplicate_payment',
        payment,
        restaurantId: order.restaurantId,
        orderId: order._id,
        reason: 'A second payment for an order that was already paid',
      });
    }
    throw new ApiError(409, 'ALREADY_PAID', 'This order is already paid — the extra payment will be refunded');
  }

  const result = await confirmCapturedPayment({
    paymentId: body.razorpay_payment_id,
    razorpayOrderId: body.razorpay_order_id,
    expectedPaise: expectedOrderPaise(order),
  });
  if (!result.ok) {
    await rejectOrderPayment(order, result);
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'This payment could not be accepted for this order');
  }
  return recordCapturedPayment(order, body.razorpay_payment_id, result.payment, 'verify');
};

/**
 * Settles a bill with a payment that has been checked (confirmCapturedPayment): one atomic
 * markPaid carrying the payment. A payment that loses a race — the other path (verify/webhook)
 * already settled the bill with it, the waiter settled it at the counter, or the bill was
 * re-priced — is never silently dropped: the first is a success, the others are owed back.
 */
const settleBillWithPayment = async (bill, payment, via) => {
  await supersedeRefusedFlag(Bill, bill._id, payment.id);
  try {
    return await billingService.markPaid({
      billId: bill._id,
      restaurantId: bill.restaurantId,
      paymentMethod: 'online',
      payment: { id: payment.id, amountPaise: payment.amount, fee: payment.fee ?? null, tax: payment.tax ?? null, via },
    });
  } catch (err) {
    if (err?.code === 'BILL_ALREADY_PAID') {
      if (err.details?.paidWith === payment.id) return Bill.findById(bill._id);
      await recordStrayPayment({
        kind: 'bill_already_settled',
        payment,
        restaurantId: bill.restaurantId,
        billId: bill._id,
        reason: 'Paid online after the bill was already settled',
      });
    } else if (err?.code === 'BILL_TOTAL_CHANGED') {
      await rejectBillPayment(bill, { payment, reason: 'The bill changed while it was being paid' });
    }
    throw err;
  }
};

// A payment against a bill that is no longer open (settled at the counter, or by another
// payment). Recorded as owed back when captured; never counted.
const handleLateBillPayment = async (bill, payment) => {
  if (bill.razorpayPaymentId === payment.id) return;
  await recordUncountedPayment({
    kind: 'bill_already_settled',
    payment,
    restaurantId: bill.restaurantId,
    billId: bill._id,
    reason: 'Paid online after the bill was already settled',
  });
};

// Same scheme as verifyOrderPayment above, against a Bill instead of an Order — a guest
// paying their dine-in bill online (controllers/publicBill.controller.js). Settles the bill
// through billing.service.js's markPaid (which also closes the TableSession and settles every
// order in it — one settlement path shared with the staff-side mark-paid flow). Returns the
// settled bill.
export const verifyBillPayment = async (bill, body) => {
  if (!intentIdsOf(bill).includes(body.razorpay_order_id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This payment does not belong to this bill');
  }
  if (!assertValidSignature(body)) {
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment signature verification failed');
  }

  if (bill.status !== 'open') {
    if (bill.razorpayPaymentId === body.razorpay_payment_id) return bill;
    const payment = await gatewayCall('payments.fetch', () => getRazorpay().payments.fetch(body.razorpay_payment_id));
    if (payment.order_id === body.razorpay_order_id) await handleLateBillPayment(bill, payment);
    throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has already been settled — your payment will be refunded');
  }

  const result = await confirmCapturedPayment({
    paymentId: body.razorpay_payment_id,
    razorpayOrderId: body.razorpay_order_id,
    expectedPaise: expectedBillPaise(bill),
  });
  if (!result.ok) {
    await rejectBillPayment(bill, result);
    const err = new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'This payment could not be accepted for this bill');
    // Razorpay itself confirmed this payment can't settle the bill (wrong amount / order) — the
    // only refusal that may reopen the table. A bad signature proves nothing about anyone's
    // payment: anyone holding the table QR can send one.
    err.gatewayChecked = true;
    throw err;
  }
  return settleBillWithPayment(bill, result.payment, 'verify');
};

// Webhook signature is a SEPARATE scheme from the client-side one above: HMAC-SHA256 of
// the raw request body using RAZORPAY_WEBHOOK_SECRET (a distinct secret from the key
// secret), sent in the X-Razorpay-Signature header. Needs the exact raw bytes, not a
// re-serialized JSON object — see app.js for why this route gets express.raw() instead
// of the global express.json().
export const verifyWebhookSignature = (rawBody, signature) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = hmacHex(rawBody, env.RAZORPAY_WEBHOOK_SECRET);
  return timingSafeEqualHex(expected, signature);
};

const settleOrderFromWebhook = async (order, payment) => {
  if (UNCOUNTABLE.includes(order.paymentStatus)) {
    if (order.razorpayPaymentId !== payment.id) {
      // A second, different payment for an order that is already paid — the customer paid
      // twice. Never counted; owed back.
      await recordUncountedPayment({
        kind: 'duplicate_payment',
        payment,
        restaurantId: order.restaurantId,
        orderId: order._id,
        reason: 'A second payment for an order that was already paid',
      });
    }
    return;
  }

  const result = await confirmCapturedPayment({
    paymentId: payment.id,
    razorpayOrderId: payment.order_id,
    expectedPaise: expectedOrderPaise(order),
  });
  if (result.ok) await recordCapturedPayment(order, payment.id, result.payment, 'webhook');
  else await rejectOrderPayment(order, result);
};

const settleBillFromWebhook = async (bill, payment) => {
  if (bill.status !== 'open') {
    await handleLateBillPayment(bill, payment);
    return;
  }

  const result = await confirmCapturedPayment({
    paymentId: payment.id,
    razorpayOrderId: payment.order_id,
    expectedPaise: expectedBillPaise(bill),
  });
  if (!result.ok) {
    await rejectBillPayment(bill, result);
    return;
  }
  try {
    await settleBillWithPayment(bill, result.payment, 'webhook');
  } catch (err) {
    // Settled by the client's verify with this payment, or already recorded as owed back by
    // settleBillWithPayment. Anything else is a real failure — Razorpay should redeliver.
    if (err?.code === 'BILL_ALREADY_PAID' || err?.code === 'BILL_TOTAL_CHANGED') {
      logger.warn({ billId: bill._id, code: err.code }, 'Webhook bill payment not counted');
      return;
    }
    throw err;
  }
};

const SETTLING_EVENTS = new Set(['payment.captured', 'order.paid']);
const REFUND_EVENTS = new Set(['refund.processed', 'refund.failed', 'refund.created']);

// Fallback path for when the client-side verify call never arrives (network drop, app
// killed mid-payment) — reaches the same end state via Razorpay's own server-to-server
// delivery instead of the customer's device. Every branch is idempotent: Razorpay delivers
// at least once, and the controller additionally de-duplicates by event id.
//
// Returns 'processed' or 'ignored' for the WebhookEvent record. Throws for failures; an
// error with `transient: true` means "ask Razorpay to retry".
export const handleWebhookEvent = async (event) => {
  const type = event?.event;
  if (REFUND_EVENTS.has(type)) return handleRefundWebhook(event);
  if (!SETTLING_EVENTS.has(type) && type !== 'payment.failed') return 'ignored';

  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id) return 'ignored';

  // Any Razorpay order the document has had — a retry may have replaced the current one.
  const byIntent = { $or: [{ paymentIntentId: payment.order_id }, { paymentIntentHistory: payment.order_id }] };
  const order = await Order.findOne(byIntent);
  if (order) {
    if (SETTLING_EVENTS.has(type)) {
      await settleOrderFromWebhook(order, payment);
    } else if (order.paymentIntentId !== payment.order_id) {
      // A failure on a Razorpay order this order has since replaced (a retry made a new one):
      // history, not news about the payment the customer is making now.
      return 'ignored';
    } else {
      // A late/duplicate payment.failed must not undo a payment that already succeeded (or
      // was refunded) — conditional, so it can't race one either.
      await Order.updateOne(
        { _id: order._id, paymentStatus: { $nin: UNCOUNTABLE } },
        { $set: { paymentStatus: 'failed', paymentFailureReason: payment.error_description || 'Payment failed at the gateway' } }
      );
    }
    return 'processed';
  }

  // Not an Order's paymentIntentId — check whether it's a dine-in Bill being paid
  // instead (controllers/publicBill.controller.js's payBill).
  const bill = await Bill.findOne(byIntent);
  if (bill) {
    if (SETTLING_EVENTS.has(type)) await settleBillFromWebhook(bill, payment);
    return 'processed';
  }

  logger.warn(
    { razorpayOrderId: payment.order_id, event: type },
    'Razorpay webhook for unknown order/bill — no matching paymentIntentId'
  );
  return 'processed';
};
