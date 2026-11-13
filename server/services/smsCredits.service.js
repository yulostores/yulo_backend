import crypto from 'crypto';
import mongoose from 'mongoose';
import Seller from '../models/Seller.js';
import SmsCreditPurchase from '../models/SmsCreditPurchase.js';
import { env } from '../config/env.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise, toRupees } from '../utils/money.js';
import { smsCost } from '../utils/couponPricing.js';
import logger from '../utils/logger.js';
import { createRazorpayOrder, confirmCapturedPayment } from './payment.service.js';
import { recordStrayPayment } from './refund.service.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { logActivity } from './activityLog.service.js';
import { isTemplateSmsLive } from './sms/templateSender.js';
import { numberSmsBill } from './sellerBills.service.js';

// Prepaid reminder-SMS credits for coupon partners (§ CB10). 1 credit = 1 SMS. Packs and price
// come from CouponSettings (smsCreditPackSizes, smsPricePaise + smsGstPercent → ₹3.54 per SMS).
//
// The balance (Seller.smsCreditsBalance) only ever moves by single conditional updates:
//   credit  { _id, smsCreditPurchaseIds: { $ne: purchase } } → +credits, remember the purchase
//           — a purchase is credited once however many times its payment is confirmed;
//   debit   { _id, smsCreditsBalance: { $gte: 1 } } → −1 — parallel sends can't go below zero;
//   refund  +1 when a debited SMS then failed to send.
//
// Paid like plans (services/sellerSubscription.service.js): Razorpay verify or webhook, whichever
// lands first; or a super admin's "Amount Received".

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const rupees = (paise) => toRupees(paise);

// ── Views ─────────────────────────────────────────────────────────────────────

const priceOf = (credits, settings) => {
  const cost = smsCost(credits, settings);
  return { pricePaise: cost.pricePaise, gstPaise: cost.gstPaise, totalPaise: cost.totalPaise, total: rupees(cost.totalPaise) };
};

export const purchaseView = (p) => ({
  _id: p._id,
  credits: p.credits,
  status: p.status,
  amount: { pricePaise: p.pricePaise, gstPaise: p.gstPaise, totalPaise: p.totalPaise, total: rupees(p.totalPaise) },
  method: p.payment?.method ?? null,
  reference: p.payment?.method === 'manual' ? p.payment.manual?.reference ?? null : p.payment?.razorpayPaymentId ?? null,
  paidAt: p.paidAt ?? null,
  creditedAt: p.creditedAt ?? null,
  createdAt: p.createdAt,
});

/** GET /api/seller/sms-credits — balance, the price per SMS, the packs on sale, recent purchases. */
export const creditsView = async (sellerId) => {
  const [seller, settings, purchases] = await Promise.all([
    Seller.findById(sellerId).select('smsCreditsBalance').lean(),
    getActiveCouponSettings(),
    SmsCreditPurchase.find({ sellerId, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  return {
    balance: seller.smsCreditsBalance ?? 0,
    perSms: { ...priceOf(1, settings), gstPercent: settings.smsGstPercent },
    packs: settings.smsCreditPackSizes.map((credits) => ({ credits, ...priceOf(credits, settings) })),
    // False until reminder SMS can really be delivered (services/sms/templateSender.js) — the
    // portal shows the shop as "coming soon" and buying is refused.
    available: isTemplateSmsLive(),
    purchases: purchases.map(purchaseView),
  };
};

// ── Balance ───────────────────────────────────────────────────────────────────

/** Adds a paid purchase's credits to the balance — once. Returns true when it added them now. */
export const applyCredits = async (purchase) => {
  const res = await Seller.updateOne(
    { _id: purchase.sellerId, smsCreditPurchaseIds: { $ne: purchase._id } },
    { $inc: { smsCreditsBalance: purchase.credits }, $push: { smsCreditPurchaseIds: purchase._id } }
  );
  await SmsCreditPurchase.updateOne({ _id: purchase._id, creditedAt: null }, { $set: { creditedAt: new Date() } });
  if (res.modifiedCount === 1) logger.info({ sellerId: purchase.sellerId, purchaseId: purchase._id, credits: purchase.credits }, 'SMS credits added');
  return res.modifiedCount === 1;
};

/** Takes one credit. False when the balance is empty (nothing taken). */
export const debitOne = async (sellerId) => {
  const res = await Seller.updateOne({ _id: sellerId, smsCreditsBalance: { $gte: 1 } }, { $inc: { smsCreditsBalance: -1 } });
  return res.modifiedCount === 1;
};

/** Gives back one credit (an SMS that was paid for and then failed to send). */
export const refundOne = (sellerId) => Seller.updateOne({ _id: sellerId }, { $inc: { smsCreditsBalance: 1 } });

// ── Paying ────────────────────────────────────────────────────────────────────

const assertCanBuy = async (sellerId) => {
  const seller = await Seller.findById(sellerId).select('status').lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  if (seller.status !== 'active') throw new ApiError(409, 'SELLER_NOT_ACTIVE', 'SMS credits are for approved, active businesses');
};

/** pending → paid, then credit. Idempotent: an already-paid purchase is only (re)credited. */
const markPaid = async (purchaseId, { amountPaise, razorpayPaymentId = null }) => {
  const set = { status: 'paid', paidAt: new Date(), 'payment.amountPaise': amountPaise };
  if (razorpayPaymentId) set['payment.razorpayPaymentId'] = razorpayPaymentId;
  await SmsCreditPurchase.updateOne({ _id: purchaseId, status: 'pending_payment' }, { $set: set });
  const purchase = await SmsCreditPurchase.findById(purchaseId).lean();
  if (purchase.status !== 'paid') throw new ApiError(409, 'INVALID_STATE', `A ${purchase.status} purchase cannot be paid`);
  await applyCredits(purchase);
  await numberSmsBill(purchaseId); // its bill — idempotent
  return SmsCreditPurchase.findById(purchaseId).lean();
};

/** POST /api/seller/sms-credits/purchase { credits } — a pending purchase and its Razorpay order. */
export const startPurchase = async (sellerId, credits) => {
  if (!isTemplateSmsLive()) throw new ApiError(503, 'SMS_NOT_AVAILABLE', 'Reminder SMS are not available yet — credits will be on sale soon');
  await assertCanBuy(sellerId);
  const settings = await getActiveCouponSettings();
  if (!settings.smsCreditPackSizes.includes(credits)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Choose one of the packs: ${settings.smsCreditPackSizes.join(', ')} SMS`);
  }
  const cost = smsCost(credits, settings);
  const purchase = await SmsCreditPurchase.create({
    sellerId,
    credits,
    unitPricePaise: settings.smsPricePaise,
    gstPercent: settings.smsGstPercent,
    ...cost,
    payment: { method: 'razorpay' },
  });
  let razorpayOrder;
  try {
    razorpayOrder = await createRazorpayOrder({
      amountPaise: cost.totalPaise,
      receipt: `sms_${purchase._id}`,
      notes: { kind: 'sms_credits', purchaseId: String(purchase._id), sellerId: String(sellerId), credits: String(credits) },
    });
  } catch (err) {
    await SmsCreditPurchase.deleteOne({ _id: purchase._id, status: 'pending_payment' });
    throw err;
  }
  if (razorpayOrder) await SmsCreditPurchase.updateOne({ _id: purchase._id }, { $set: { 'payment.razorpayOrderId': razorpayOrder.id } });
  return {
    purchase: purchaseView(await SmsCreditPurchase.findById(purchase._id).lean()),
    razorpayOrder,
    paymentSimulated: !razorpayOrder && paymentSimulationEnabled,
  };
};

const hmacHex = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const refuse = async (purchase, { payment, reason }, kind = 'sms_credits_payment_refused') => {
  logger.error({ purchaseId: purchase._id, razorpayPaymentId: payment?.id, reason }, 'SMS credit payment refused');
  if (payment?.status === 'captured') {
    await recordStrayPayment({ kind, payment, sellerId: purchase.sellerId, smsCreditPurchaseId: purchase._id, reason });
  }
};

// One captured payment → the purchase. Paid by THIS payment already → no-op; by another → owed back.
const settle = async (purchase, payment) => {
  if (purchase.status !== 'pending_payment') {
    if (purchase.payment?.razorpayPaymentId !== payment.id) {
      await refuse(purchase, { payment, reason: 'A second payment for SMS credits already paid' }, 'sms_credits_duplicate_payment');
      return { duplicate: true };
    }
    await applyCredits(purchase); // repairs a crash between "paid" and "credited"
    return { purchase };
  }
  const result = await confirmCapturedPayment({
    paymentId: payment.id,
    razorpayOrderId: purchase.payment.razorpayOrderId,
    expectedPaise: purchase.totalPaise,
  });
  if (!result.ok) {
    await refuse(purchase, result);
    return { refused: true };
  }
  return { purchase: await markPaid(purchase._id, { amountPaise: result.payment.amount, razorpayPaymentId: result.payment.id }) };
};

/** POST /api/seller/sms-credits/purchase/:id/verify — the Checkout handler's three fields. */
export const verifyPurchase = async (sellerId, purchaseId, body) => {
  const purchase = mongoose.isValidObjectId(purchaseId) ? await SmsCreditPurchase.findOne({ _id: purchaseId, sellerId }).lean() : null;
  if (!purchase) throw new ApiError(404, 'NOT_FOUND', 'Purchase not found');
  if (purchase.payment?.method !== 'razorpay' || purchase.payment.razorpayOrderId !== body.razorpay_order_id) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This payment does not belong to this purchase');
  }
  if (!env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment verification is not configured');
  const expected = hmacHex(`${body.razorpay_order_id}|${body.razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
  if (!sameHex(expected, body.razorpay_signature)) throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment signature verification failed');
  const result = await settle(purchase, { id: body.razorpay_payment_id });
  if (result.refused) throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'This payment could not be accepted for these credits');
  if (result.duplicate) throw new ApiError(409, 'ALREADY_PAID', 'These credits were already paid for — the second payment will be refunded');
  return purchaseView(await SmsCreditPurchase.findById(purchaseId).lean());
};

/** The payment webhook's branch for SMS credits. False when the order isn't a credit purchase. */
export const settleFromWebhook = async (payment) => {
  const purchase = await SmsCreditPurchase.findOne({ 'payment.razorpayOrderId': payment.order_id }).lean();
  if (!purchase) return false;
  await settle(purchase, payment);
  return true;
};

/** Is this Razorpay order an SMS-credit purchase? (For webhook events that settle nothing.) */
export const isCreditOrder = (razorpayOrderId) => SmsCreditPurchase.exists({ 'payment.razorpayOrderId': razorpayOrderId });

/** Local development only (ALLOW_PAYMENT_SIMULATION, never production). */
export const simulatePurchase = async (sellerId, purchaseId) => {
  if (!paymentSimulationEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  const purchase = mongoose.isValidObjectId(purchaseId) ? await SmsCreditPurchase.findOne({ _id: purchaseId, sellerId }).lean() : null;
  if (!purchase) throw new ApiError(404, 'NOT_FOUND', 'Purchase not found');
  return purchaseView(await markPaid(purchase._id, { amountPaise: purchase.totalPaise }));
};

// ── Amount Received ───────────────────────────────────────────────────────────

/**
 * POST /api/admin/sellers/:id/sms-credits/manual — money the seller paid Yulo directly for
 * credits. Any number of credits; the amount must be their price (₹3.54 each, GST included)
 * unless an override reason is given. One entry per payment reference.
 */
export const recordManualPayment = async (sellerId, adminId, { credits, amountRupees, mode, reference, receivedOn, note, overrideReason }) => {
  await assertCanBuy(sellerId);
  const settings = await getActiveCouponSettings();
  const cost = smsCost(credits, settings);
  const amountPaise = toPaise(amountRupees);
  if (amountPaise !== cost.totalPaise && !overrideReason) {
    throw new ApiError(422, 'AMOUNT_MISMATCH', `${credits} SMS credits cost ₹${rupees(cost.totalPaise)} including GST. Enter that amount, or give a reason for the difference.`, {
      expectedPaise: cost.totalPaise,
      receivedPaise: amountPaise,
    });
  }
  let purchase;
  try {
    purchase = await SmsCreditPurchase.create({
      sellerId: oid(sellerId),
      credits,
      unitPricePaise: settings.smsPricePaise,
      gstPercent: settings.smsGstPercent,
      ...cost,
      payment: {
        method: 'manual',
        amountPaise,
        manual: { mode, reference, receivedOn, recordedBy: adminId, note: note ?? null, overrideReason: amountPaise !== cost.totalPaise ? overrideReason : null },
      },
    });
  } catch (err) {
    if (err?.code === 11000) throw new ApiError(409, 'DUPLICATE_PAYMENT', 'A payment with this reference has already been recorded for this business');
    throw err;
  }
  const paid = await markPaid(purchase._id, { amountPaise });
  await logActivity({
    adminId,
    action: 'SELLER_SMS_CREDITS_RECORDED',
    targetType: 'seller',
    targetId: sellerId,
    metadata: { purchaseId: purchase._id, credits, amountPaise, expectedPaise: cost.totalPaise, mode, reference, overrideReason: amountPaise !== cost.totalPaise ? overrideReason : null },
  });
  const seller = await Seller.findById(sellerId).select('smsCreditsBalance').lean();
  return { purchase: purchaseView(paid), balance: seller.smsCreditsBalance };
};
