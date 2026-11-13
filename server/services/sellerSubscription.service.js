import crypto from 'crypto';
import Seller from '../models/Seller.js';
import SellerSubscription from '../models/SellerSubscription.js';
import CouponPlan from '../models/CouponPlan.js';
import Coupon from '../models/Coupon.js';
import { env } from '../config/env.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise, toRupees } from '../utils/money.js';
import { planTotals } from '../utils/couponPricing.js';
import { generateCouponCode } from '../utils/couponCode.js';
import logger from '../utils/logger.js';
import { createRazorpayOrder, confirmCapturedPayment } from './payment.service.js';
import { recordStrayPayment } from './refund.service.js';
import { logActivity } from './activityLog.service.js';
import { COUPON_VALIDITY_DAYS, PLAN_ONLINE_HANDLING_FEE_PERCENT } from '../config/coupon.config.js';
import { numberSubscriptionBill } from './sellerBills.service.js';

// A coupon partner's plan purchases and the coupon stock they carry (models/SellerSubscription.js).
//
// Paid two ways, one end state:
//   Razorpay     POST /api/seller/subscriptions creates the subscription (pending_payment) and its
//                Razorpay order; the portal's verify call OR the payment webhook activates it —
//                whichever lands first, the other is a no-op.
//   Amount       a super admin records money the seller paid Yulo directly (NEFT, UPI, cash…);
//   Received     the subscription is created and activated in the same call.
//
// Activation is one conditional update (pending_payment → active) that fixes the stock, then the
// plan's complimentary coupons, which carry deterministic issue keys so a retried activation can
// never create more than the plan's count. No transaction (standalone MongoDB): each step is
// idempotent on its own, so a crash between them is repaired by simply activating again.
//
// Stock moves only through takeOne / giveBack, single atomic updates guarded by `remaining > 0` /
// `issued > 0`, so parallel coupon issues can never draw more than was bought.

// ── Views ─────────────────────────────────────────────────────────────────────

const rupees = (paise) => (Number.isInteger(paise) ? toRupees(paise) : null);

export const planView = (plan) => {
  const t = planTotals(plan); // offline: price + GST (what "Amount Received" expects)
  const o = planTotals(plan, { handlingFeePercent: PLAN_ONLINE_HANDLING_FEE_PERCENT }); // Razorpay
  return {
    _id: plan._id,
    key: plan.key,
    name: plan.name,
    gstPercent: plan.gstPercent,
    couponAllocation: plan.couponAllocation,
    basePaise: t.basePaise,
    gstPaise: t.gstPaise,
    totalPaise: t.totalPaise,
    price: { base: rupees(t.basePaise), gst: rupees(t.gstPaise), total: rupees(t.totalPaise) },
    // What an online (Razorpay) purchase charges: price + handling fee, then GST on both.
    online: {
      handlingFeePercent: PLAN_ONLINE_HANDLING_FEE_PERCENT,
      handlingFeePaise: o.handlingFeePaise,
      gstPaise: o.gstPaise,
      totalPaise: o.totalPaise,
      price: { base: rupees(o.basePaise), handlingFee: rupees(o.handlingFeePaise), gst: rupees(o.gstPaise), total: rupees(o.totalPaise) },
    },
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
  };
};

// What a seller sees of a subscription: customer-coupon stock only. The complimentary count is
// left out of the plan snapshot on purpose (§ Business rules — Visibility).
export const sellerSubscriptionView = (s) => ({
  _id: s._id,
  plan: { key: s.planSnapshot.key, name: s.planSnapshot.name, couponAllocation: s.planSnapshot.couponAllocation },
  status: s.status,
  amount: {
    basePaise: s.planSnapshot.basePricePaise,
    handlingFeePaise: s.planSnapshot.handlingFeePaise ?? 0,
    gstPaise: s.planSnapshot.gstPaise,
    totalPaise: s.planSnapshot.totalPaise,
    total: rupees(s.planSnapshot.totalPaise),
  },
  paidPaise: s.payment?.amountPaise ?? null,
  method: s.payment?.method ?? null,
  reference: s.payment?.method === 'manual' ? s.payment.manual?.reference ?? null : s.payment?.razorpayPaymentId ?? null,
  allocated: s.allocated,
  issued: s.issued,
  remaining: s.remaining,
  activatedAt: s.activatedAt,
  exhaustedAt: s.exhaustedAt,
  createdAt: s.createdAt,
});

// The admin sees everything, complimentary included.
export const adminSubscriptionView = (s, complimentary = null) => ({
  ...sellerSubscriptionView(s),
  plan: { ...s.planSnapshot },
  payment: s.payment,
  complimentary,
});

// ── Plans ─────────────────────────────────────────────────────────────────────

export const listActivePlans = async () =>
  (await CouponPlan.find({ isActive: true }).sort({ sortOrder: 1, basePricePaise: 1 }).lean()).map(planView);

// `online` = bought through Razorpay: the payment handling fee is part of the price sold.
const snapshotOf = (plan, { online = false } = {}) => {
  const handlingFeePercent = online ? PLAN_ONLINE_HANDLING_FEE_PERCENT : 0;
  const t = planTotals(plan, { handlingFeePercent });
  return {
    planId: plan._id,
    key: plan.key,
    name: plan.name,
    basePricePaise: t.basePaise,
    handlingFeePercent,
    handlingFeePaise: t.handlingFeePaise,
    gstPercent: plan.gstPercent,
    gstPaise: t.gstPaise,
    totalPaise: t.totalPaise,
    couponAllocation: plan.couponAllocation,
    complimentaryCount: plan.complimentaryCount,
  };
};

const activePlanByKey = async (planKey) => {
  const plan = await CouponPlan.findOne({ key: planKey, isActive: true }).lean();
  if (!plan) throw new ApiError(404, 'PLAN_NOT_FOUND', 'That plan is not on sale');
  return plan;
};

const assertSellerActive = async (sellerId) => {
  const seller = await Seller.findById(sellerId).select('status categoryId').lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  if (seller.status !== 'active') {
    throw new ApiError(409, 'SELLER_NOT_ACTIVE', 'Plans can only be activated for an approved, active business', { status: seller.status });
  }
  return seller;
};

// ── Activation ────────────────────────────────────────────────────────────────

// The plan's complimentary coupons. Issue keys "plan:<subscription>:<n>" make the insert
// idempotent: a second activation inserts nothing (duplicate keys are skipped).
const ensureComplimentaryCoupons = async (subscription) => {
  const count = subscription.planSnapshot.complimentaryCount ?? 0;
  if (count > 0) {
    const seller = await Seller.findById(subscription.sellerId).select('categoryId').lean();
    const defaultValidityDays = COUPON_VALIDITY_DAYS; // complimentary coupons: same fixed 30 days
    const issuedAt = subscription.activatedAt ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + defaultValidityDays * 864e5);
    const rows = Array.from({ length: count }, (_, i) => ({
      code: generateCouponCode(),
      kind: 'complimentary',
      sellerId: subscription.sellerId,
      subscriptionId: subscription._id,
      categoryId: seller.categoryId,
      source: { type: 'plan', id: subscription._id },
      issueKey: `plan:${subscription._id}:${i + 1}`,
      status: 'issued',
      issuedAt,
      expiresAt,
    }));
    try {
      await Coupon.insertMany(rows, { ordered: false });
    } catch (err) {
      // Duplicate issue keys = already created by an earlier activation. Anything else is real.
      const writeErrors = err?.writeErrors ?? [];
      if (!(err?.code === 11000 || (writeErrors.length && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000)))) throw err;
    }
  }
  if (!subscription.complimentaryCreatedAt) {
    await SellerSubscription.updateOne({ _id: subscription._id, complimentaryCreatedAt: null }, { $set: { complimentaryCreatedAt: new Date() } });
  }
};

/**
 * Activates a paid subscription: stock = the plan's customer coupons, plus its complimentary
 * coupons. `payment` = { amountPaise, razorpayPaymentId? } is recorded on the way.
 * Idempotent — an already-active subscription is returned as it is (its complimentary coupons
 * re-checked). Returns { subscription, activatedNow }.
 */
export const activate = async (subscriptionId, { payment = {}, by = null } = {}) => {
  const current = await SellerSubscription.findById(subscriptionId).lean();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Subscription not found');

  const set = {
    status: 'active',
    allocated: current.planSnapshot.couponAllocation,
    remaining: current.planSnapshot.couponAllocation,
    issued: 0,
    activatedAt: new Date(),
  };
  if (payment.amountPaise != null) set['payment.amountPaise'] = payment.amountPaise;
  if (payment.razorpayPaymentId) set['payment.razorpayPaymentId'] = payment.razorpayPaymentId;

  const activated = await SellerSubscription.findOneAndUpdate(
    { _id: subscriptionId, status: 'pending_payment' },
    { $set: set },
    { new: true }
  ).lean();
  const subscription = activated ?? (await SellerSubscription.findById(subscriptionId).lean());
  if (!['active', 'exhausted'].includes(subscription.status)) {
    throw new ApiError(409, 'INVALID_STATE', `A ${subscription.status} subscription cannot be activated`);
  }
  await ensureComplimentaryCoupons(subscription);
  // Its bill (one number per paid purchase). Idempotent, so a repeated activation is harmless.
  const billNumber = await numberSubscriptionBill(subscription._id);
  if (billNumber && !subscription.billNumber) subscription.billNumber = billNumber;
  if (activated) {
    logger.info({ subscriptionId, sellerId: subscription.sellerId, plan: subscription.planSnapshot.key, by }, 'Seller plan activated');
  }
  return { subscription, activatedNow: Boolean(activated) };
};

// ── Stock ─────────────────────────────────────────────────────────────────────

/**
 * Takes one customer coupon of stock from the seller's oldest active subscription. Returns that
 * subscription (after the decrement) or null when the seller has none left.
 */
export const takeOne = async (sellerId) => {
  const sub = await SellerSubscription.findOneAndUpdate(
    { sellerId, status: 'active', remaining: { $gt: 0 } },
    { $inc: { remaining: -1, issued: 1 } },
    { sort: { activatedAt: 1, _id: 1 }, new: true }
  ).lean();
  if (!sub) return null;
  if (sub.remaining === 0) {
    await SellerSubscription.updateOne(
      { _id: sub._id, status: 'active', remaining: 0 },
      { $set: { status: 'exhausted', exhaustedAt: new Date() } }
    );
  }
  return sub;
};

/** Returns one unit of stock (a coupon voided before use). A no-op when nothing was issued. */
export const giveBack = async (subscriptionId) =>
  SellerSubscription.findOneAndUpdate(
    { _id: subscriptionId, status: { $in: ['active', 'exhausted'] }, issued: { $gt: 0 } },
    { $inc: { remaining: 1, issued: -1 }, $set: { status: 'active', exhaustedAt: null } },
    { new: true }
  ).lean();

// ── Seller reads ──────────────────────────────────────────────────────────────

/** The seller's purchases (newest first) and the stock still available across active plans. */
export const sellerSubscriptions = async (sellerId) => {
  const subs = await SellerSubscription.find({ sellerId }).sort({ createdAt: -1 }).lean();
  const live = subs.filter((s) => ['active', 'exhausted'].includes(s.status));
  const active = live.filter((s) => s.status === 'active').sort((a, b) => a.activatedAt - b.activatedAt);
  return {
    subscriptions: subs.map(sellerSubscriptionView),
    stock: {
      allocated: live.reduce((n, s) => n + s.allocated, 0),
      issued: live.reduce((n, s) => n + s.issued, 0),
      remaining: active.reduce((n, s) => n + s.remaining, 0),
    },
    // The plan coupons are currently drawn from (oldest active first), else the newest bought.
    currentPlan: active.at(0) ? sellerSubscriptionView(active.at(0)) : live.at(0) ? sellerSubscriptionView(live.at(0)) : null,
    // Every plan with coupons left, oldest first — a seller who bought Basic then Plus has both.
    activePlans: active.map((s) => ({ key: s.planSnapshot.key, name: s.planSnapshot.name })),
  };
};

// ── Razorpay purchase ─────────────────────────────────────────────────────────

/** POST /api/seller/subscriptions — a pending subscription and the Razorpay order to pay it. */
export const startPurchase = async (sellerId, planKey) => {
  await assertSellerActive(sellerId);
  const plan = await activePlanByKey(planKey);
  const snapshot = snapshotOf(plan, { online: true });
  const subscription = await SellerSubscription.create({ sellerId, planSnapshot: snapshot, payment: { method: 'razorpay' } });

  let razorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder({
      amountPaise: snapshot.totalPaise,
      receipt: `sub_${subscription._id}`,
      notes: { kind: 'seller_subscription', subscriptionId: String(subscription._id), sellerId: String(sellerId), plan: plan.key },
    });
  } catch (err) {
    await SellerSubscription.deleteOne({ _id: subscription._id, status: 'pending_payment' });
    throw err;
  }
  if (razorpayOrder) {
    await SellerSubscription.updateOne({ _id: subscription._id }, { $set: { 'payment.razorpayOrderId': razorpayOrder.id } });
  }
  const saved = await SellerSubscription.findById(subscription._id).lean();
  return {
    subscription: sellerSubscriptionView(saved),
    // null only in local payment simulation — the portal then calls .../simulate-payment.
    razorpayOrder,
    paymentSimulated: !razorpayOrder && paymentSimulationEnabled,
  };
};

const hmacHex = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The Razorpay payment we refuse for a subscription. Captured money is owed back (a stray
// payment, refunded from the admin refunds screen); an authorization is left to lapse.
const refuse = async (subscription, { payment, reason }, kind = 'seller_payment_refused') => {
  logger.error({ subscriptionId: subscription._id, razorpayPaymentId: payment?.id, reason }, 'Seller plan payment refused');
  if (payment?.status === 'captured') {
    await recordStrayPayment({ kind, payment, sellerId: subscription.sellerId, sellerSubscriptionId: subscription._id, reason });
  }
};

// One captured, checked payment → the subscription. Already paid by THIS payment → no-op; already
// paid by another one → the newcomer is a duplicate, owed back.
const settle = async (subscription, payment) => {
  if (subscription.status !== 'pending_payment') {
    if (subscription.payment?.razorpayPaymentId !== payment.id) {
      await refuse(subscription, { payment, reason: 'A second payment for a plan that was already paid' }, 'seller_duplicate_payment');
      return { subscription, activatedNow: false, duplicate: true };
    }
    return { subscription, activatedNow: false };
  }
  const result = await confirmCapturedPayment({
    paymentId: payment.id,
    razorpayOrderId: subscription.payment.razorpayOrderId,
    expectedPaise: subscription.planSnapshot.totalPaise,
  });
  if (!result.ok) {
    await refuse(subscription, result);
    return { refused: true, reason: result.reason };
  }
  return activate(subscription._id, { payment: { amountPaise: result.payment.amount, razorpayPaymentId: result.payment.id }, by: 'razorpay' });
};

/** POST /api/seller/subscriptions/:id/verify — the Checkout handler's three fields. */
export const verifyPurchase = async (sellerId, subscriptionId, body) => {
  const subscription = await SellerSubscription.findOne({ _id: subscriptionId, sellerId }).lean();
  if (!subscription) throw new ApiError(404, 'NOT_FOUND', 'Subscription not found');
  if (subscription.payment?.method !== 'razorpay' || subscription.payment.razorpayOrderId !== body.razorpay_order_id) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This payment does not belong to this plan purchase');
  }
  if (!env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment verification is not configured');
  const expected = hmacHex(`${body.razorpay_order_id}|${body.razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
  if (!sameHex(expected, body.razorpay_signature)) {
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment signature verification failed');
  }

  const result = await settle(subscription, { id: body.razorpay_payment_id });
  if (result.refused) throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'This payment could not be accepted for this plan');
  if (result.duplicate) {
    throw new ApiError(409, 'ALREADY_PAID', 'This plan was already paid — the second payment will be refunded');
  }
  return sellerSubscriptionView(await SellerSubscription.findById(subscriptionId).lean());
};

/**
 * The payment webhook's branch for plan purchases (services/payment.service.js#handleWebhookEvent).
 * Returns false when the Razorpay order isn't a plan purchase, so the caller carries on.
 */
export const settleFromWebhook = async (payment) => {
  const subscription = await SellerSubscription.findOne({ 'payment.razorpayOrderId': payment.order_id }).lean();
  if (!subscription) return false;
  await settle(subscription, payment);
  return true;
};

/** Local development only (ALLOW_PAYMENT_SIMULATION, never production): pay without a gateway. */
export const simulatePurchase = async (sellerId, subscriptionId) => {
  if (!paymentSimulationEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  const subscription = await SellerSubscription.findOne({ _id: subscriptionId, sellerId }).lean();
  if (!subscription) throw new ApiError(404, 'NOT_FOUND', 'Subscription not found');
  await activate(subscriptionId, { payment: { amountPaise: subscription.planSnapshot.totalPaise }, by: 'simulation' });
  return sellerSubscriptionView(await SellerSubscription.findById(subscriptionId).lean());
};

// ── Amount Received ───────────────────────────────────────────────────────────

/**
 * A super admin records a payment the seller made to Yulo outside the gateway, and the plan is
 * activated at once. The amount must be the plan's total unless an override reason is given (a
 * negotiated price, a part-payment the business accepted). One entry per payment reference.
 */
export const recordManualPayment = async (sellerId, adminId, { planKey, amountRupees, mode, reference, receivedOn, note, overrideReason }) => {
  await assertSellerActive(sellerId);
  const plan = await activePlanByKey(planKey);
  const snapshot = snapshotOf(plan);
  const amountPaise = toPaise(amountRupees);
  if (amountPaise !== snapshot.totalPaise && !overrideReason) {
    throw new ApiError(422, 'AMOUNT_MISMATCH', `The ${plan.name} plan costs ₹${toRupees(snapshot.totalPaise)} including GST. Enter that amount, or give a reason for the difference.`, {
      expectedPaise: snapshot.totalPaise,
      receivedPaise: amountPaise,
    });
  }

  let subscription;
  try {
    subscription = await SellerSubscription.create({
      sellerId,
      planSnapshot: snapshot,
      payment: {
        method: 'manual',
        amountPaise,
        manual: {
          mode,
          reference,
          receivedOn,
          recordedBy: adminId,
          note: note ?? null,
          overrideReason: amountPaise !== snapshot.totalPaise ? overrideReason : null,
        },
      },
    });
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError(409, 'DUPLICATE_PAYMENT', 'A payment with this reference has already been recorded for this business');
    }
    throw err;
  }
  const { subscription: active } = await activate(subscription._id, { payment: { amountPaise }, by: adminId });

  await logActivity({
    adminId,
    action: 'SELLER_PLAN_PAYMENT_RECORDED',
    targetType: 'seller',
    targetId: sellerId,
    metadata: {
      subscriptionId: subscription._id,
      plan: plan.key,
      amountPaise,
      expectedPaise: snapshot.totalPaise,
      mode,
      reference,
      overrideReason: amountPaise !== snapshot.totalPaise ? overrideReason : null,
    },
  });
  return active;
};

/** GET /api/admin/sellers/:id/subscriptions — everything, complimentary coupons counted. */
export const adminSubscriptions = async (sellerId) => {
  if (!(await Seller.exists({ _id: sellerId }))) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  const subs = await SellerSubscription.find({ sellerId }).sort({ createdAt: -1 }).lean();
  const comp = await Coupon.aggregate([
    { $match: { subscriptionId: { $in: subs.map((s) => s._id) }, kind: 'complimentary' } },
    { $group: { _id: { sub: '$subscriptionId', status: '$status' }, count: { $sum: 1 } } },
  ]);
  const bySub = new Map();
  for (const row of comp) {
    const key = String(row._id.sub);
    const entry = bySub.get(key) ?? { total: 0, issued: 0, redeemed: 0, expired: 0, void: 0 };
    entry.total += row.count;
    entry[row._id.status] = (entry[row._id.status] ?? 0) + row.count;
    bySub.set(key, entry);
  }
  return subs.map((s) => adminSubscriptionView(s, bySub.get(String(s._id)) ?? { total: 0, issued: 0, redeemed: 0, expired: 0, void: 0 }));
};
