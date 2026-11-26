import mongoose from 'mongoose';

// A payment the super admin made to a restaurant — any day, for the full balance or part of it.
// This replaced the weekly settlement statement (config/payoutMode.js): the restaurant's ledger
// (models/RestaurantLedgerEntry.js) is still where every rupee owed is recorded, and each payment
// here is booked there as a `payout` debit, so the balance owed can never be paid twice.
// Append-only, like the ledger: a mistake is corrected with a ledger adjustment, never by editing
// or deleting a payment. All amounts in PAISE.
export const PAYMENT_MODES = ['neft', 'imps', 'rtgs', 'upi', 'cash', 'cheque', 'other'];

const restaurantPaymentSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    // Human number, unique and running across all restaurants (`RP-000001`).
    paymentNumber: { type: String, required: true },
    amountPaise: { type: Number, required: true, min: 1, validate: Number.isInteger },
    // 'full' when it paid the whole balance owed at that moment, otherwise 'partial'.
    kind: { type: String, enum: ['full', 'partial'], required: true },
    mode: { type: String, enum: PAYMENT_MODES, required: true },
    // The bank UTR / UPI reference / cheque number.
    reference: { type: String, trim: true, required: true },
    // The day the money was sent (what the restaurant sees as "paid on").
    paidAt: { type: Date, required: true },
    note: { type: String, trim: true, default: '' },
    // What was owed when the payment was made, and how much of that had cleared (Razorpay had
    // settled it to Yulo). Paying more than had cleared is allowed — Yulo pays it in advance.
    balanceBeforePaise: { type: Number, required: true },
    clearedBeforePaise: { type: Number, required: true },
    // The verified bank account it was sent to, as shown to the admin (never the full number).
    beneficiary: {
      holderName: { type: String, default: null },
      accountNumberLast4: { type: String, default: null },
      ifsc: { type: String, default: null },
      bankName: { type: String, default: null },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

restaurantPaymentSchema.index({ paymentNumber: 1 }, { unique: true });
restaurantPaymentSchema.index({ restaurantId: 1, paidAt: -1 });
restaurantPaymentSchema.index({ paidAt: -1 });

export default mongoose.model('RestaurantPayment', restaurantPaymentSchema);
