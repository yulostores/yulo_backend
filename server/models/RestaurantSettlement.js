import mongoose from 'mongoose';

// One restaurant's settlement for one week: the sum of the ledger rows
// (models/RestaurantLedgerEntry.js) it claimed, and what happened to the payout.
// services/settlement.service.js generates and moves them; nothing else writes one.
//
// status (and the two axes both portals show — utils/payoutStatus.js):
//   draft       generated, eligible, bank transfer not scheduled
//   approved    SCHEDULED for payout.scheduledFor (B12 — "schedule" is the approval)
//   processing  RELEASED: the admin sent the transfer (net banking, or a bank-file batch, B9);
//               waiting for the admin to record the bank's result
//   paid        the admin recorded the bank reference — nothing turns paid on its own
//   failed      the bank rejected it: still eligible, unpaid, no fee, no automatic retry —
//               the admin reschedules (back to approved with a new date)
//   on_hold     not payable as it stands: negative balance (carried forward), bank account not
//               verified, or held by an admin — see holdReason
//   carried_forward  the payout failed and, instead of retrying it, its amount was moved into
//               the restaurant's next settlement (a carry_forward credit) — closed
//
// All amounts in PAISE.
const settlementSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: {
      type: String,
      enum: ['draft', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'carried_forward'],
      default: 'draft',
    },
    totals: {
      // What customers paid Yulo for this restaurant's online orders and bills.
      grossCustomerPaid: { type: Number, default: 0 },
      // Customers' tips inside grossCustomerPaid — passed to the riders in full, so the statement
      // shows where that part of what customers paid went (never the restaurant's).
      tips: { type: Number, default: 0 },
      // "Yulo Money" — the platform fee and delivery charge customers paid Yulo directly.
      yuloMoneyPlatformFee: { type: Number, default: 0 },
      yuloMoneyDelivery: { type: Number, default: 0 },
      // Delivery the restaurant paid for (free-delivery orders).
      restaurantBorneDelivery: { type: Number, default: 0 },
      settlementCharge: {
        base: { type: Number, default: 0 },
        gst: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
      // Platform fee (+ settlement charge on it) owed for bills paid at the counter.
      counterPlatformFees: { type: Number, default: 0 },
      // Razorpay fees on refunded orders, where the restaurant bears them.
      refundGatewayFees: { type: Number, default: 0 },
      // Admin corrections, signed (credit +, debit −); penalties are counted separately.
      adjustments: { type: Number, default: 0 },
      // A previous week's negative balance brought into this one (≤ 0).
      carryForwardIn: { type: Number, default: 0 },
      // Earlier settlements whose payout failed and was carried forward into this one (≥ 0).
      failedPayoutsCarriedIn: { type: Number, default: 0 },
      // This week's negative balance moved to next week (≥ 0; zeroes this week's net).
      carryForwardOut: { type: Number, default: 0 },
      planCharges: { type: Number, default: 0 },
      adCharges: { type: Number, default: 0 },
      penalties: { type: Number, default: 0 },
      // Credits − debits of every row in this settlement. What the restaurant is paid.
      netPayable: { type: Number, default: 0 },
    },
    entryCount: { type: Number, default: 0 },
    payout: {
      provider: { type: String, default: null },
      providerPayoutId: { type: String, default: null },
      utr: { type: String, default: null },
      initiatedAt: { type: Date, default: null },
      paidAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
      attempts: { type: Number, default: 0 },
      // ── B12 manual lifecycle ──
      // The release date the admin picked (local midnight of that day in the settlement zone).
      scheduledFor: { type: Date, default: null },
      scheduledAt: { type: Date, default: null },
      scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      releasedAt: { type: Date, default: null },
      releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      // This transfer attempt's reference (YULO-ATT-<yyyymmdd>-<seq>), shown while processing and
      // kept on the failure — the bank's own reference (utr) is typed in by the admin when paid.
      attemptRef: { type: String, default: null },
      // "Date credited" the admin entered with the bank reference.
      creditedAt: { type: Date, default: null },
      // The last failed attempt — kept after a reschedule (the owner is told it happened).
      lastFailure: {
        reason: { type: String, default: null }, // utils/payoutStatus.js FAILURE_REASONS
        note: { type: String, default: null },
        at: { type: Date, default: null },
        attemptRef: { type: String, default: null },
      },
      markedPaidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      // Bank-file payouts (B9): the batch it went out in and the reference printed on that
      // payment line — what the bank's response file is matched back on. A fresh reference per
      // attempt, so a retried payment is never confused with the failed one.
      batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutBatch', default: null },
      reference: { type: String, default: null },
      failedAt: { type: Date, default: null },
      // The verified bank account this payment was put on a batch for. The file is only built
      // while the restaurant's account is still exactly this one (an owner changing it after the
      // batch was made must not redirect the money to details nobody verified). `fingerprint`
      // is a hash of the encrypted number + IFSC + holder name — never the number itself.
      beneficiary: {
        fingerprint: { type: String, default: null },
        accountNumberLast4: { type: String, default: null },
        ifsc: { type: String, default: null },
        verifiedAt: { type: Date, default: null },
      },
      // Earlier attempts that did not end in a payment (failed, returned, retried) — what the
      // current fields held before they were cleared for the next attempt. Admin audit trail;
      // a returned payment's UTR and paid date live here, not on the failed settlement.
      history: [
        {
          _id: false,
          batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutBatch', default: null },
          reference: { type: String, default: null },
          outcome: { type: String, default: null }, // failed | returned
          attemptRef: { type: String, default: null },
          utr: { type: String, default: null },
          paidAt: { type: Date, default: null },
          failedAt: { type: Date, default: null },
          reason: { type: String, default: null },
        },
      ],
    },
    // NEGATIVE_BALANCE_CARRIED_FORWARD | NEGATIVE_BALANCE | PAYOUT_ACCOUNT_NOT_VERIFIED |
    // MANUAL (an admin's hold: holdCode says why, holdNote is staff-only — never sent to the owner).
    holdReason: { type: String, default: null },
    holdCode: { type: String, enum: ['dispute_review', 'bank_details_review', 'compliance_review', 'other', null], default: null },
    holdNote: { type: String, default: null },
    heldAt: { type: Date, default: null },
    heldBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // The latest clearsAt among its rows — when the last of its money reached Yulo.
    clearedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    generatedAt: { type: Date, default: null },
    // Held while one generator re-totals this settlement (settlement.service.js): a second
    // generator, an approve or a hold in that window is refused instead of interleaving with it.
    // Expires on its own, so a crashed generator never blocks the settlement for good.
    generationLock: {
      token: { type: String, default: null },
      until: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

settlementSchema.index({ restaurantId: 1, periodStart: 1 }, { unique: true });
settlementSchema.index({ periodStart: -1, status: 1 });
settlementSchema.index({ status: 1, updatedAt: -1 });
settlementSchema.index({ 'payout.reference': 1 }, { sparse: true });
settlementSchema.index({ 'payout.attemptRef': 1 }, { sparse: true });

export default mongoose.model('RestaurantSettlement', settlementSchema);
