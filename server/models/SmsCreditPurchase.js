import mongoose from 'mongoose';
import { MANUAL_PAYMENT_MODES } from '../config/coupon.config.js';

// A coupon partner buying a pack of reminder-SMS credits (1 credit = 1 SMS) — the twin of
// SellerSubscription for SMS. Paid through Razorpay (verify or webhook, whichever lands first) or
// recorded by a super admin as "Amount Received".
//
//   pending_payment → paid         (credits added once: see services/smsCredits.service.js)
//   pending_payment → cancelled
//
// The price is snapshotted from CouponSettings when the purchase is created.

const smsCreditPurchaseSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    credits: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true, min: 0 },
    gstPercent: { type: Number, required: true, min: 0 },
    pricePaise: { type: Number, required: true, min: 0 },
    gstPaise: { type: Number, required: true, min: 0 },
    totalPaise: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['pending_payment', 'paid', 'cancelled'], default: 'pending_payment' },
    payment: {
      method: { type: String, enum: ['razorpay', 'manual'], required: true },
      amountPaise: { type: Number, default: null },
      razorpayOrderId: { type: String, default: null },
      razorpayPaymentId: { type: String, default: null },
      manual: {
        mode: { type: String, enum: [...MANUAL_PAYMENT_MODES, null], default: null },
        reference: { type: String, trim: true, default: null },
        receivedOn: { type: Date, default: null },
        recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        note: { type: String, trim: true, default: null },
        overrideReason: { type: String, trim: true, default: null },
      },
    },
    paidAt: { type: Date, default: null },
    // Set once the credits are on the seller's balance.
    creditedAt: { type: Date, default: null },
    // The bill Yulo issues for this purchase — see SellerSubscription.billNumber.
    billNumber: { type: String, default: null },
  },
  { timestamps: true }
);

smsCreditPurchaseSchema.index({ sellerId: 1, createdAt: -1 });
smsCreditPurchaseSchema.index({ billNumber: 1 }, { unique: true, partialFilterExpression: { billNumber: { $type: 'string' } } });
smsCreditPurchaseSchema.index(
  { 'payment.razorpayOrderId': 1 },
  { unique: true, partialFilterExpression: { 'payment.razorpayOrderId': { $type: 'string' } } }
);
smsCreditPurchaseSchema.index(
  { 'payment.razorpayPaymentId': 1 },
  { unique: true, partialFilterExpression: { 'payment.razorpayPaymentId': { $type: 'string' } } }
);
smsCreditPurchaseSchema.index(
  { sellerId: 1, 'payment.manual.reference': 1 },
  { unique: true, partialFilterExpression: { 'payment.method': 'manual', 'payment.manual.reference': { $type: 'string' } } }
);

export default mongoose.model('SmsCreditPurchase', smsCreditPurchaseSchema);
