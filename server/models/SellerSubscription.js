import mongoose from 'mongoose';
import { SUBSCRIPTION_STATUSES, MANUAL_PAYMENT_MODES } from '../config/coupon.config.js';

// One plan purchase by a seller, and the coupon stock it carries.
//
//   pending_payment → active      paid (Razorpay verify / webhook, or admin "Amount Received")
//   active          → exhausted   the last customer coupon was issued (remaining hit 0)
//   pending_payment → cancelled   abandoned or refused
//
// Stock counts CUSTOMER coupons only: allocated = planSnapshot.couponAllocation,
// remaining = allocated − issued (+ coupons voided back). The complimentary coupons are created
// as Coupon rows at activation and are never part of these counts, so nothing a seller reads
// from here can reveal them. remaining/issued change only through single atomic updates
// guarded by `remaining > 0` (services/sellerSubscription.service.js, CB4).

const sellerSubscriptionSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    // The plan as it was sold — later plan edits never reach an existing subscription.
    planSnapshot: {
      planId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponPlan', required: true },
      key: { type: String, required: true },
      name: { type: String, required: true },
      basePricePaise: { type: Number, required: true },
      gstPercent: { type: Number, required: true },
      gstPaise: { type: Number, required: true },
      totalPaise: { type: Number, required: true },
      couponAllocation: { type: Number, required: true },
      complimentaryCount: { type: Number, required: true },
    },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'pending_payment' },
    payment: {
      method: { type: String, enum: ['razorpay', 'manual'], required: true },
      amountPaise: { type: Number, default: null },
      razorpayOrderId: { type: String, default: null },
      razorpayPaymentId: { type: String, default: null },
      // Admin "Amount Received": a payment made to Yulo directly, outside the gateway.
      manual: {
        mode: { type: String, enum: [...MANUAL_PAYMENT_MODES, null], default: null },
        reference: { type: String, trim: true, default: null },
        receivedOn: { type: Date, default: null },
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        note: { type: String, trim: true, default: null },
        overrideReason: { type: String, trim: true, default: null },
      },
    },
    allocated: { type: Number, default: 0, min: 0 },
    issued: { type: Number, default: 0, min: 0 },
    remaining: { type: Number, default: 0, min: 0 },
    activatedAt: { type: Date, default: null },
    exhaustedAt: { type: Date, default: null },
    // Set once the complimentary coupons exist, so a repeated activation never creates more.
    complimentaryCreatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Stock is drawn oldest active subscription first.
sellerSubscriptionSchema.index({ sellerId: 1, status: 1, activatedAt: 1 });
sellerSubscriptionSchema.index(
  { 'payment.razorpayOrderId': 1 },
  { unique: true, partialFilterExpression: { 'payment.razorpayOrderId': { $type: 'string' } } }
);
// One "Amount Received" entry per payment reference per seller: a double-click, or two admins
// recording the same bank transfer, can't activate the plan twice.
sellerSubscriptionSchema.index(
  { sellerId: 1, 'payment.manual.reference': 1 },
  { unique: true, partialFilterExpression: { 'payment.method': 'manual', 'payment.manual.reference': { $type: 'string' } } }
);
sellerSubscriptionSchema.index(
  { 'payment.razorpayPaymentId': 1 },
  { unique: true, partialFilterExpression: { 'payment.razorpayPaymentId': { $type: 'string' } } }
);

export default mongoose.model('SellerSubscription', sellerSubscriptionSchema);
