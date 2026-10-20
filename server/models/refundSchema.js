import mongoose from 'mongoose';

// A refund of a captured Razorpay payment — shared by Order and Bill. One per document:
// services/refund.service.js claims it atomically, so a double cancel, a retried request and a
// webhook racing them can never send two refunds for one payment.
//
//   none        nothing owed
//   pending     owed, not yet sent to Razorpay (flagged — e.g. a payment we refused in B1)
//   processing  sent; Razorpay has accepted it, money is on its way back
//   processed   Razorpay confirms the money has been returned
//   failed      Razorpay refused or failed it — an admin retries (POST …/refunds/:orderId/retry)
//
// The legacy top-level `refundStatus` (none | pending | refunded) is kept in step for the
// screens that still read it.
export const refundSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['none', 'pending', 'processing', 'processed', 'failed'],
      default: 'none',
    },
    amountPaise: { type: Number, default: null },
    razorpayRefundId: { type: String, default: null },
    reason: { type: String, default: null },
    // Why the order was refunded — the key into Finance Settings' refundFeeBorneBy.
    cause: {
      type: String,
      enum: [
        'restaurant_reject',
        'approval_timeout',
        'customer_cancel_before_accept',
        'customer_cancel_before_preparation',
        'restaurant_cancel_after_accept',
        'paid_after_cancel',
        null,
      ],
      default: null,
    },
    // 'system' or an admin's user id (as a string) for a manual retry.
    initiatedBy: { type: String, default: null },
    initiatedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    // Who absorbs Razorpay's non-refundable fee on this payment: 'restaurant' (debited on its
    // ledger as refund_gateway_fee) or 'platform'.
    feeBorneBy: { type: String, enum: ['restaurant', 'platform', null], default: null },
  },
  { _id: false }
);

// refund.status → the legacy three-state refundStatus.
export const legacyRefundStatus = (status) => {
  if (status === 'processed') return 'refunded';
  if (status === 'pending' || status === 'processing' || status === 'failed') return 'pending';
  return 'none';
};
