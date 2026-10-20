import mongoose from 'mongoose';

const payoutSchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryPartner', required: true },
    periodType: { type: String, enum: ['weekly', 'monthly'], required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    deliveriesCount: { type: Number, default: 0 },
    // The base rate in force when the payout was last computed (informational — pay itself is
    // the sum of each delivery's frozen earningsBreakdown, below).
    perDeliveryRate: { type: Number, required: true },
    // Sums of the period's delivered orders' deliveryAssignment.earningsBreakdown (rupees):
    // basePay + distancePay (+ surge − penalty) = grossEarnings; tips are the customers' and go
    // to the rider in full on top.
    basePay: { type: Number, default: 0 },
    distancePay: { type: Number, default: 0 },
    tips: { type: Number, default: 0 },
    grossEarnings: { type: Number, default: 0 },
    incentives: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    netPayable: { type: Number, default: 0 },
    // Only WEEKLY payouts are paid; a monthly row is a statement of the same deliveries (paying
    // both would pay the rider twice — services/payout.service.js refuses it).
    status: { type: String, enum: ['pending', 'processing', 'paid'], default: 'pending' },
    computedAt: { type: Date, default: null },
    paidAt: { type: Date },
    notes: { type: String },
    adjustedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// periodType is part of the key: a week and a month that start on the same day (the 1st is a
// Monday) are two different rows, not one overwriting the other. scripts/fixPayoutPeriodIndex.js
// replaces the old { partnerId, periodStart } index on existing databases.
payoutSchema.index({ partnerId: 1, periodType: 1, periodStart: 1 }, { unique: true });
payoutSchema.index({ status: 1 });

export default mongoose.model('Payout', payoutSchema);
