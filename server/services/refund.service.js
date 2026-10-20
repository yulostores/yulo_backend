import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import Restaurant from '../models/Restaurant.js';
import StrayPayment from '../models/StrayPayment.js';
import { legacyRefundStatus } from '../models/refundSchema.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise, toRupees } from '../utils/money.js';
import logger from '../utils/logger.js';
import { getRazorpay } from './razorpayClient.js';
import { getActiveSettings } from './financeSettings.service.js';
import { onCancelledAfterPreparation, recordRefundGatewayFee } from './ledger.service.js';

// Refunds and the cancellation rules that decide them (PAYMENT_IMPLEMENTATION_PROMPTS.md
// § Business rules → Refunds & cancellations):
//
//   restaurant rejects / approval times out           → full refund
//   restaurant (kitchen, floor) or admin cancels later → full refund
//   customer cancels before the kitchen starts         → full refund
//   customer cancels after the kitchen started         → no refund; the restaurant is paid
//   a payment lands on an order already cancelled      → full refund
//
// Who absorbs Razorpay's fee (it is never returned on a refund) comes from Finance Settings
// → refundFeeBorneBy[cause]; when it is the restaurant, it is debited on its ledger.
//
// Only an order actually paid online is ever refunded — there is nothing to send back for
// cash on delivery, a counter payment, or an online order that never got paid.

// Statuses in which the kitchen has started (or finished) the food. A customer cancelling
// from here gets no refund — and must say they understand that (confirmNoRefund).
export const PREPARATION_STARTED_STATUSES = new Set(['preparing', 'ready']);
// Statuses a customer may still cancel from. Past these the food is on its way.
export const CUSTOMER_CANCELLABLE_STATUSES = new Set(['placed', 'confirmed', 'preparing', 'ready']);

// The cause of a refund, from who cancelled and where the order was when they did.
const causeFor = ({ actorRole, previousStatus }) => {
  if (actorRole === 'customer') {
    return previousStatus === 'placed' ? 'customer_cancel_before_accept' : 'customer_cancel_before_preparation';
  }
  if (previousStatus === 'placed') return actorRole === 'system' ? 'approval_timeout' : 'restaurant_reject';
  return 'restaurant_cancel_after_accept';
};

// The same, for an order cancelled some time ago (a payment landing late) — from the record.
const causeFromRecord = (order) => {
  if (order.cancelledBy === 'customer') {
    return order.acceptedAt ? 'customer_cancel_before_preparation' : 'customer_cancel_before_accept';
  }
  if (order.cancelledBy === 'system') return 'approval_timeout';
  const acceptedAt = order.acceptedAt;
  if (order.cancelledBy === 'restaurant' && !acceptedAt) return 'restaurant_reject';
  return 'restaurant_cancel_after_accept';
};

// Causes that have no Finance Settings key of their own: a customer cancelling an accepted order
// before cooking starts follows the before-accept rule (the settings carry one rule for "customer
// cancelled before the food was started"), and a payment that lands on an order already
// cancelled — nobody could act on it while it was unpaid — is always the platform's cost.
const FEE_RULE_ALIASES = { customer_cancel_before_preparation: 'customer_cancel_before_accept' };
const PLATFORM_BORNE_CAUSES = new Set(['paid_after_cancel']);
const feeBearerFor = (settings, cause) => {
  if (!cause || PLATFORM_BORNE_CAUSES.has(cause)) return 'platform';
  return settings.refundFeeBorneBy?.[FEE_RULE_ALIASES[cause] ?? cause] ?? 'restaurant';
};

const isPaidOnline = (order) =>
  order.paymentStatus === 'paid' &&
  (order.paymentChannel === 'online' || (!order.paymentChannel && order.paymentMethod === 'online'));

const capturedAmountPaise = (order) => order.paymentAmountPaise ?? toPaise(order.grandTotal ?? order.subtotal ?? 0);

const setRefund = (fields) => {
  const set = {};
  for (const [key, value] of Object.entries(fields)) set[`refund.${key}`] = value;
  if (fields.status) set.refundStatus = legacyRefundStatus(fields.status);
  return set;
};

// A 'processing' refund with no Razorpay refund id is one whose attempt died between the claim
// and Razorpay's answer (crash, timeout). After this long it is treated as failed and can be
// claimed again. Re-sending is safe: Razorpay refuses to refund more than was captured.
const STALE_PROCESSING_MS = 15 * 60 * 1000;

// A refund that may be (re)started now: not yet sent, failed, or stuck mid-attempt.
const claimableRefund = (now, { allowNone }) => ({
  $or: [
    { 'refund.status': { $in: allowNone ? ['none', 'pending', 'failed', null] : ['pending', 'failed'] } },
    {
      'refund.status': 'processing',
      'refund.razorpayRefundId': null,
      'refund.initiatedAt': { $lt: new Date(now.getTime() - STALE_PROCESSING_MS) },
    },
  ],
});

const modelName = (Model) => Model.modelName;

/**
 * The one refund engine for an Order, a Bill or a StrayPayment. Claims the document's refund
 * atomically (so a double cancel, a retried request and a webhook racing them can never send
 * two refunds), sends it to Razorpay and records the outcome. Any error after the claim marks
 * the refund 'failed' — it is never left 'processing' with nothing sent.
 *
 * `claimFilter` narrows what may be refunded; `amountOf(claimed)` is what to send back;
 * `afterClaim(claimed)` runs once per claim (the refund-fee ledger debit for an order).
 */
const runRefund = async (Model, id, { claimFilter, set, amountOf, afterClaim }) => {
  const now = new Date();
  const claimed = await Model.findOneAndUpdate(
    { _id: id, razorpayPaymentId: { $ne: null }, ...claimFilter(now) },
    { $set: setRefund({ status: 'processing', initiatedAt: now, failureReason: null, razorpayRefundId: null, ...set }), $inc: { 'refund.attempts': 1 } },
    { new: true }
  );
  if (!claimed) return Model.findById(id);

  try {
    const amountPaise = amountOf(claimed);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      return markRefundFailed(Model, id, 'No refundable amount recorded — refund by hand');
    }
    await Model.updateOne({ _id: id }, { $set: { 'refund.amountPaise': amountPaise } });
    claimed.refund.amountPaise = amountPaise;

    if (afterClaim) await afterClaim(claimed);

    // A dev-simulated payment has no real money behind it: "refund" it on the spot.
    if (String(claimed.razorpayPaymentId).startsWith('sim_')) {
      if (!paymentSimulationEnabled) {
        logger.error({ id, model: modelName(Model) }, 'Simulated payment found while simulation is off — not refunded');
        return markRefundFailed(Model, id, 'Simulated payment — nothing to refund');
      }
      return markRefundProcessed(Model, { id, razorpayRefundId: `sim_rfnd_${id}`, paymentId: claimed.razorpayPaymentId });
    }

    const rzp = getRazorpay();
    if (!rzp) return markRefundFailed(Model, id, 'Payment gateway is not configured');

    let refund;
    try {
      refund = await rzp.payments.refund(claimed.razorpayPaymentId, {
        amount: amountPaise,
        speed: 'normal',
        notes: { [`${modelName(Model)}Id`]: String(id), cause: claimed.refund?.cause ?? '', reason: claimed.refund?.reason ?? '' },
      });
    } catch (err) {
      return markRefundFailed(Model, id, err?.error?.description ?? err?.message ?? 'Refund failed at the gateway');
    }
    await Model.updateOne({ _id: id }, { $set: { 'refund.razorpayRefundId': refund.id } });
    // Normal-speed refunds are usually 'pending' until Razorpay's refund.processed webhook.
    if (refund.status === 'processed') return markRefundProcessed(Model, { id, razorpayRefundId: refund.id, paymentId: claimed.razorpayPaymentId });
    return Model.findById(id);
  } catch (err) {
    logger.error({ err, id, model: modelName(Model) }, 'Refund attempt crashed after it was claimed');
    return markRefundFailed(Model, id, err?.message ?? 'Refund attempt failed');
  }
};

/**
 * Refunds an order's online payment in full. Idempotent: the order is claimed atomically, so
 * a second call while one is in flight (or after it succeeded) does nothing and returns the
 * order as it stands. A failed (or stuck) refund can be retried by calling this again.
 *
 * Also refunds a payment we refused for the order (flagged 'pending' with its amount by
 * payment.service.js) — the order itself was never paid then.
 *
 * @param {string} orderId
 * @param {object} opts { reason, cause, initiatedBy ('system' | admin id) }
 * @returns the order after the attempt
 */
export const initiateFullRefund = async (orderId, { reason, cause, initiatedBy = 'system' }) => {
  const settings = await getActiveSettings();
  const feeBorneBy = feeBearerFor(settings, cause);
  return runRefund(Order, orderId, {
    claimFilter: (now) => ({
      $and: [
        claimableRefund(now, { allowNone: true }),
        {
          $or: [
            { paymentStatus: 'paid' },
            // A refused payment flagged for return: owed whatever the order's own state.
            { 'refund.status': { $in: ['pending', 'failed', 'processing'] }, 'refund.amountPaise': { $ne: null } },
          ],
        },
      ],
    }),
    set: { reason, cause: cause ?? null, initiatedBy: String(initiatedBy), feeBorneBy },
    amountOf: (claimed) => claimed.refund?.amountPaise ?? capturedAmountPaise(claimed),
    // Razorpay keeps its fee whatever happens next — charge it to whoever bears it now, once.
    // Only for the order's own payment: a refused payment's fee was never recorded as the
    // restaurant's.
    afterClaim: (claimed) =>
      claimed.paymentStatus === 'paid' && cause ? recordRefundGatewayFee(claimed, { cause, feeBorneBy }) : null,
  });
};

// A bill or stray payment flagged for return (refund.amountPaise recorded when it was flagged).
const refundFlagged = (Model, id, { initiatedBy }) =>
  runRefund(Model, id, {
    claimFilter: (now) => ({ ...claimableRefund(now, { allowNone: false }), 'refund.amountPaise': { $ne: null } }),
    set: { initiatedBy: String(initiatedBy), feeBorneBy: 'platform' },
    amountOf: (claimed) => claimed.refund?.amountPaise,
  });

const markRefundProcessed = async (Model, { id, razorpayRefundId, paymentId = null }) => {
  const doc = await Model.findOneAndUpdate(
    // Never over a different refund than the one in flight (a late event for an older attempt).
    { _id: id, 'refund.status': { $ne: 'processed' }, 'refund.razorpayRefundId': { $in: [razorpayRefundId, null] } },
    {
      $set: {
        ...setRefund({ status: 'processed', processedAt: new Date(), failureReason: null }),
        'refund.razorpayRefundId': razorpayRefundId,
      },
    },
    { new: true }
  );
  // Only an order whose own payment was refunded becomes 'refunded'; refunding a payment we
  // refused leaves the order free to be paid properly. Matched on the refunded payment too, so
  // a refund of some other payment can never mark the order's real payment refunded.
  if (Model === Order) {
    await Order.updateOne(
      { _id: id, paymentStatus: 'paid', 'refund.status': 'processed', ...(paymentId ? { razorpayPaymentId: paymentId } : {}) },
      { $set: { paymentStatus: 'refunded' } }
    );
    return Order.findById(id);
  }
  return doc ?? Model.findById(id);
};

// Logged loudly and left 'failed' — the admin refunds screen lists these for a retry.
const markRefundFailed = async (Model, id, failureReason) => {
  logger.error({ id, model: modelName(Model), failureReason }, 'REFUND FAILED — needs an admin retry');
  const doc = await Model.findOneAndUpdate(
    { _id: id, 'refund.status': { $ne: 'processed' } },
    { $set: setRefund({ status: 'failed', failureReason }) },
    { new: true }
  );
  return doc ?? Model.findById(id);
};

/**
 * A round of a dine-in table cancelled after the table's bill was paid online. The money was
 * paid on the bill, not the round, so there is no per-round payment to refund automatically and
 * the share owed back (food, its GST, service charge) is a judgement call — flagged for an admin
 * with the round's food total as a guide.
 */
export const flagCancelledPaidDineInRound = async (order) => {
  const bill = order.tableSessionId
    ? await Bill.findOne({ tableSessionId: order.tableSessionId, status: 'paid', paymentChannel: 'online' }).lean()
    : null;
  logger.error(
    { orderId: order._id, billId: bill?._id ?? null },
    'Dine-in round cancelled after its bill was paid online — refund needs an admin decision'
  );
  if (!bill?.razorpayPaymentId) return;
  await StrayPayment.updateOne(
    { kind: 'dine_in_round_cancelled', razorpayPaymentId: bill.razorpayPaymentId, orderId: order._id },
    {
      $setOnInsert: {
        restaurantId: order.restaurantId,
        billId: bill._id,
        razorpayOrderId: bill.paymentIntentId ?? null,
        amountPaise: null,
        reason: `Round cancelled after the bill was paid online (round food total ₹${Number(order.subtotal ?? 0).toFixed(2)})`,
        refund: { status: 'pending', reason: 'Dine-in round cancelled after payment' },
      },
    },
    { upsert: true }
  );
};

/**
 * Everything that follows an order being cancelled, decided here in one place. Called by
 * kitchen.service.js's updateOrderStatus after the cancellation is written.
 */
export const onOrderCancelled = async (order, { previousStatus, actorRole }) => {
  // The customer walked away once the kitchen had started: no refund, the restaurant is paid.
  if (actorRole === 'customer' && PREPARATION_STARTED_STATUSES.has(previousStatus)) {
    await onCancelledAfterPreparation(order);
    return order;
  }
  if (!isPaidOnline(order)) return order;

  try {
    if (!order.razorpayPaymentId && order.tableSessionId) {
      await flagCancelledPaidDineInRound(order);
      return order;
    }
    return await initiateFullRefund(order._id, {
      reason: order.cancellationReason ?? 'Order cancelled',
      cause: causeFor({ actorRole, previousStatus }),
      initiatedBy: 'system',
    });
  } catch (err) {
    // The cancellation itself stands; the refund is retryable from the admin screen.
    logger.error({ err, orderId: order._id }, 'Refund initiation failed after cancellation');
    return order;
  }
};

/**
 * A payment captured on an order that had already been cancelled (the customer paid after the
 * restaurant rejected, or after the timeout). Refunded in full straight away. Called with the
 * order as it is in the database right after the payment was written — so a cancellation
 * racing the payment is always seen by one side or the other. Returns true when a refund was
 * started.
 */
export const refundIfCancelled = async (order) => {
  if (order.status !== 'cancelled' || !isPaidOnline(order)) return false;
  await initiateFullRefund(order._id, {
    reason: 'Payment received after the order was cancelled',
    // Cancelled while still unpaid (expired, rejected, …) and paid afterwards: the restaurant
    // never had a payable order to act on, so it doesn't bear the fee.
    cause:
      order.cancelledAt && order.paidAt && new Date(order.cancelledAt) < new Date(order.paidAt)
        ? 'paid_after_cancel'
        : causeFromRecord(order),
    initiatedBy: 'system',
  });
  return true;
};

/**
 * A refused payment's refund (flagged on the order/bill — owed, in flight, done or failed) when a
 * DIFFERENT payment is about to become that document's payment. The refund moves, as it stands
 * (status, Razorpay refund id, amount), to a stray payment of its own, so:
 *   - it can't be mistaken for a refund of the new payment (a later restaurant reject would
 *     otherwise find a refund "in flight" and never refund the real payment, and its webhook
 *     would mark the real payment refunded);
 *   - Razorpay's webhook for it still finds it (by refund id, on the stray).
 * Only while the document is unsettled (an order not paid/refunded, a bill still open) — a
 * settled document's refund is a refund of its own payment. Safe against a refund webhook
 * landing mid-move: the clear only matches the refund exactly as copied, else it re-copies.
 */
export const moveRefundToStray = async (Model, docId, newPaymentId) => {
  const isBill = Model === Bill;
  const unsettled = isBill ? { status: 'open' } : { paymentStatus: { $nin: ['paid', 'refunded'] } };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const cur = await Model.findOne({ _id: docId, ...unsettled }).select('razorpayPaymentId paymentIntentId refund restaurantId').lean();
    const r = cur?.refund;
    if (!cur?.razorpayPaymentId || cur.razorpayPaymentId === newPaymentId) return;
    if (!r?.status || r.status === 'none' || r.amountPaise == null) return;

    await StrayPayment.updateOne(
      { kind: 'refused_payment', razorpayPaymentId: cur.razorpayPaymentId, orderId: isBill ? null : docId },
      {
        $set: { refund: r },
        $setOnInsert: {
          razorpayOrderId: null,
          amountPaise: r.amountPaise,
          restaurantId: cur.restaurantId ?? null,
          billId: isBill ? docId : null,
          reason: r.reason ?? r.failureReason ?? 'Refused payment',
        },
      },
      { upsert: true }
    );
    const cleared = await Model.updateOne(
      {
        _id: docId,
        ...unsettled,
        razorpayPaymentId: cur.razorpayPaymentId,
        'refund.status': r.status,
        'refund.razorpayRefundId': r.razorpayRefundId ?? null,
      },
      { $set: { refund: { status: 'none' }, refundStatus: 'none' } }
    );
    if (cleared.modifiedCount) return;
  }
  logger.error({ docId, model: modelName(Model) }, 'Could not move a refused payment\'s refund off its document — check by hand');
};

// ── Razorpay refund webhooks ──────────────────────────────────────────────────

const REFUND_MODELS = [Order, Bill, StrayPayment];

// Allowance for clock skew between Razorpay and us when telling an older refund attempt's
// event from the one in flight.
const REFUND_CLOCK_SKEW_MS = 60 * 1000;

// The document a Razorpay refund belongs to:
//   1. by refund id (exact) — and only where that document's payment is the refunded one;
//   2. for a webhook that beats our own save of the refund id: by the payment it refunds, only
//      where a refund is in flight with NO refund id yet, and the refund was created after that
//      attempt started. A late event for an OLDER attempt (whose id we replaced on a retry) never
//      matches the attempt in flight — it would otherwise undo it and allow a second refund.
const findRefundTarget = async (refund) => {
  const ownPayment = (doc) => !refund.payment_id || !doc.razorpayPaymentId || doc.razorpayPaymentId === refund.payment_id;
  for (const Model of REFUND_MODELS) {
    const docs = await Model.find({ 'refund.razorpayRefundId': refund.id }).select('_id refund razorpayPaymentId').lean();
    const doc = docs.find(ownPayment);
    if (doc) return { Model, doc };
  }
  if (!refund.payment_id) return null;
  const createdAt = refund.created_at ? refund.created_at * 1000 : null;
  for (const Model of REFUND_MODELS) {
    const doc = await Model.findOne({
      razorpayPaymentId: refund.payment_id,
      'refund.status': 'processing',
      'refund.razorpayRefundId': null,
    })
      .select('_id refund razorpayPaymentId')
      .lean();
    if (!doc) continue;
    const startedAt = doc.refund?.initiatedAt ? new Date(doc.refund.initiatedAt).getTime() : null;
    if (createdAt && startedAt && createdAt < startedAt - REFUND_CLOCK_SKEW_MS) continue;
    return { Model, doc };
  }
  return null;
};

/**
 * refund.processed / refund.failed (and refund.created, ignored). Matches the refund to an
 * order, bill or stray payment (findRefundTarget). Idempotent.
 */
export const handleRefundWebhook = async (event) => {
  const refund = event.payload?.refund?.entity;
  if (!refund?.id) return 'ignored';
  if (event.event === 'refund.created') return 'ignored';

  const target = await findRefundTarget(refund);
  if (!target) {
    logger.warn({ refundId: refund.id, paymentId: refund.payment_id }, 'Refund webhook for unknown order/bill');
    return 'processed';
  }
  const { Model, doc } = target;

  if (event.event === 'refund.processed') {
    await markRefundProcessed(Model, { id: doc._id, razorpayRefundId: refund.id, paymentId: refund.payment_id ?? null });
  } else if (event.event === 'refund.failed') {
    logger.error({ id: doc._id, refundId: refund.id }, 'REFUND FAILED (Razorpay webhook) — needs an admin retry');
    await Model.updateOne(
      // Only the attempt this event is about (its id, or the in-flight one not yet saved).
      { _id: doc._id, 'refund.status': { $ne: 'processed' }, 'refund.razorpayRefundId': { $in: [refund.id, null] } },
      {
        $set: {
          ...setRefund({ status: 'failed', failureReason: refund.error_description ?? 'Refund failed at Razorpay' }),
          'refund.razorpayRefundId': refund.id,
        },
      }
    );
  } else {
    return 'ignored';
  }
  return 'processed';
};

// ── Views ─────────────────────────────────────────────────────────────────────

const rupeeText = (paise) => `₹${toRupees(paise).toFixed(2)}`;

/**
 * What the customer is told about a refund: status, amount (rupees and paise) and a line of
 * plain-language timeline. null when no refund applies.
 */
export const customerRefundView = (order) => {
  const r = order.refund;
  if (!r || !r.status || r.status === 'none') return null;
  const amount = r.amountPaise ?? capturedAmountPaise(order);
  const timeline = {
    pending: 'A refund is due — it will be started shortly.',
    processing: `Refund of ${rupeeText(amount)} started — it usually reaches your original payment method in 5–7 business days.`,
    processed: `${rupeeText(amount)} refunded to your original payment method${r.processedAt ? ` on ${new Date(r.processedAt).toDateString()}` : ''}.`,
    failed: 'Your refund is delayed — our team has been alerted and will complete it shortly.',
  }[r.status];
  return {
    status: r.status,
    amount: toRupees(amount),
    amountPaise: amount,
    initiatedAt: r.initiatedAt ?? null,
    processedAt: r.processedAt ?? null,
    timeline,
  };
};

const REFUND_LISTS = [
  {
    kind: 'order',
    Model: Order,
    select: 'restaurantId userId type status grandTotal paymentStatus razorpayPaymentId +razorpayFee cancelledBy cancellationReason cancelledAt refund refundStatus updatedAt',
  },
  {
    kind: 'bill',
    Model: Bill,
    select: 'restaurantId billNumber tableNumber type status grandTotal paymentChannel razorpayPaymentId paymentFailureReason refund refundStatus updatedAt',
  },
  {
    kind: 'stray_payment',
    Model: StrayPayment,
    select: 'kind restaurantId orderId billId razorpayPaymentId razorpayOrderId amountPaise reason refund updatedAt',
  },
];

/**
 * Every refund owed, under way, done or failed — orders, dine-in bills and stray payments
 * (models/StrayPayment.js) — newest activity first. Each row carries `source`
 * ('order' | 'bill' | 'stray_payment'); its _id is what POST …/refunds/:id/retry takes.
 */
// An order the old code flagged as owed a refund (refundStatus 'pending') before the refund
// subdocument existed — still owed, shown as 'pending'.
const LEGACY_OWED = { refundStatus: 'pending', 'refund.status': { $in: ['none', null] } };
const isLegacyOwed = (doc) => doc.refundStatus === 'pending' && (!doc.refund?.status || doc.refund.status === 'none');

export const listRefunds = async ({ status, source, page = 1, limit = 20 }) => {
  const base = status ? { 'refund.status': status } : { 'refund.status': { $nin: ['none', null] } };
  const withLegacy = !status || status === 'pending' ? { $or: [base, LEGACY_OWED] } : base;
  const upTo = page * limit;
  const lists = await Promise.all(
    REFUND_LISTS.filter(({ kind }) => !source || kind === source).map(async ({ kind, Model, select }) => {
      const filter = Model === Order ? withLegacy : base;
      const [rows, total] = await Promise.all([
        Model.find(filter).sort({ updatedAt: -1 }).limit(upTo).select(select).lean(),
        Model.countDocuments(filter),
      ]);
      return {
        rows: rows.map((r) =>
          isLegacyOwed(r) ? { ...r, source: kind, legacy: true, refund: { ...(r.refund ?? {}), status: 'pending', amountPaise: capturedAmountPaise(r) } } : { ...r, source: kind }
        ),
        total,
      };
    })
  );
  const refunds = lists
    .flatMap((l) => l.rows)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice((page - 1) * limit, upTo);
  // The restaurant's name on each row, so the admin list doesn't look each one up.
  const restaurantIds = [...new Set(refunds.map((r) => r.restaurantId).filter(Boolean).map(String))];
  const names = new Map(
    (restaurantIds.length ? await Restaurant.find({ _id: { $in: restaurantIds } }).select('name').lean() : []).map((r) => [String(r._id), r.name])
  );
  for (const r of refunds) r.restaurantName = r.restaurantId ? names.get(String(r.restaurantId)) ?? null : null;
  return { refunds, total: lists.reduce((n, l) => n + l.total, 0), page, limit };
};

const isRetryable = (refund, now = Date.now()) =>
  ['failed', 'pending'].includes(refund?.status) ||
  (refund?.status === 'processing' &&
    !refund.razorpayRefundId &&
    refund.initiatedAt &&
    now - new Date(refund.initiatedAt).getTime() > STALE_PROCESSING_MS);

/**
 * Admin retry of a failed, never-sent or stuck refund — of an order, a bill or a stray
 * payment, whichever the id belongs to. Returns { source, doc }.
 */
export const retryRefund = async (id, adminId) => {
  const order = await Order.findById(id).lean();
  const bill = order ? null : await Bill.findById(id).lean();
  const stray = order || bill ? null : await StrayPayment.findById(id).lean();
  const doc = order ?? bill ?? stray;
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Refund not found');

  const legacy = Boolean(order) && isLegacyOwed(order);
  if (!legacy && !isRetryable(doc.refund)) {
    throw new ApiError(409, 'REFUND_NOT_RETRYABLE', `This refund is ${doc.refund?.status ?? 'not owed'} — nothing to retry`);
  }
  if (!doc.razorpayPaymentId) {
    throw new ApiError(409, 'REFUND_NOT_RETRYABLE', 'There is no captured online payment to refund');
  }

  if (order && legacy) {
    // Owed under the old code: its full payment, Yulo bears Razorpay's fee (it was never
    // recorded, so it can't fairly be charged to the restaurant now).
    if (!isPaidOnline(order)) {
      throw new ApiError(409, 'REFUND_NOT_RETRYABLE', 'This order has no captured online payment to refund');
    }
    const updated = await initiateFullRefund(id, {
      reason: order.cancellationReason ?? 'Owed before the refund system (legacy)',
      cause: null,
      initiatedBy: adminId,
    });
    return { source: 'order', doc: updated };
  }
  if (order) {
    const flagged = order.refund?.amountPaise != null && order.paymentStatus !== 'paid';
    if (!flagged && !isPaidOnline(order)) {
      throw new ApiError(409, 'REFUND_NOT_RETRYABLE', 'This order has no captured online payment to refund');
    }
    const updated = await initiateFullRefund(id, {
      reason: order.refund?.reason ?? 'Admin retry',
      cause: flagged ? null : order.refund?.cause ?? causeFromRecord(order),
      initiatedBy: adminId,
    });
    return { source: 'order', doc: updated };
  }
  if (doc.refund?.amountPaise == null && doc.amountPaise == null) {
    throw new ApiError(409, 'REFUND_AMOUNT_UNKNOWN', 'No refund amount is recorded — decide the amount and refund it from the Razorpay dashboard');
  }
  if (stray && stray.refund?.amountPaise == null) {
    await StrayPayment.updateOne({ _id: id }, { $set: { 'refund.amountPaise': stray.amountPaise } });
  }
  const Model = bill ? Bill : StrayPayment;
  return { source: bill ? 'bill' : 'stray_payment', doc: await refundFlagged(Model, id, { initiatedBy: adminId }) };
};

/**
 * Records a captured payment that cannot be counted against its order/bill and cannot be
 * flagged on that document's own refund (models/StrayPayment.js). Idempotent per payment and
 * cause. Logged at error level: until an admin refunds it, Yulo is holding a customer's money.
 */
export const recordStrayPayment = async ({ kind, payment, restaurantId = null, orderId = null, billId = null, reason }) => {
  // One owed-back record per payment, whatever the cause: verify and the webhook (or the
  // payment.captured and order.paid events) can each see the same refused payment under a
  // different cause. Already owed back as a stray, or held by an order/bill (counted there, or
  // flagged on its own refund) → nothing more to record.
  const [asStray, onOrder, onBill] = await Promise.all([
    StrayPayment.exists({ razorpayPaymentId: payment.id, kind: { $ne: 'dine_in_round_cancelled' } }),
    Order.exists({ razorpayPaymentId: payment.id }),
    Bill.exists({ razorpayPaymentId: payment.id }),
  ]);
  if (asStray || onOrder || onBill) return;
  logger.error(
    { kind, razorpayPaymentId: payment.id, orderId, billId, amountPaise: payment.amount, reason },
    'Stray payment captured — refund required'
  );
  await StrayPayment.updateOne(
    { kind, razorpayPaymentId: payment.id, orderId },
    {
      $setOnInsert: {
        razorpayOrderId: payment.order_id ?? null,
        amountPaise: payment.amount ?? null,
        restaurantId,
        billId,
        reason,
        refund: { status: 'pending', amountPaise: payment.amount ?? null, reason },
      },
    },
    { upsert: true }
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
};
