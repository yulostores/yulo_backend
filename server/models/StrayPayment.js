import mongoose from 'mongoose';
import { refundSchema } from './refundSchema.js';

// A captured Razorpay payment that cannot be counted against the order or bill it was made for,
// and cannot be flagged on that document's own `refund` either (that belongs to the document's
// real payment). Every one of these is money Yulo holds and owes back:
//
//   duplicate_payment          a second payment on an order/bill that was already paid
//   bill_already_settled       a guest paid online after the bill was settled at the counter
//   bill_total_changed         the bill was re-priced between payment and settlement
//   refused_payment            an earlier refused payment, superseded when a valid one landed
//   dine_in_round_cancelled    a round cancelled after its table's bill was paid online — the
//                              amount owed is the admin's call, so amountPaise is left null
//
// Listed and refunded from the admin refunds screen (services/refund.service.js), with the same
// refund state machine Order/Bill use.
const strayPaymentSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['duplicate_payment', 'bill_already_settled', 'bill_total_changed', 'refused_payment', 'dine_in_round_cancelled'],
      required: true,
    },
    razorpayPaymentId: { type: String, required: true },
    razorpayOrderId: { type: String, default: null },
    amountPaise: { type: Number, default: null },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },
    reason: { type: String, default: null },
    refund: { type: refundSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// One record per payment per cause (per round, for a cancelled dine-in round) — recording the
// same stray payment twice (verify and webhook both seeing it) is a no-op.
strayPaymentSchema.index({ kind: 1, razorpayPaymentId: 1, orderId: 1 }, { unique: true });
strayPaymentSchema.index({ 'refund.status': 1, updatedAt: -1 });
strayPaymentSchema.index({ 'refund.razorpayRefundId': 1 }, { sparse: true });

export default mongoose.model('StrayPayment', strayPaymentSchema);
