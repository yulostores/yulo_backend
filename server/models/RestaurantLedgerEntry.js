import mongoose from 'mongoose';

// The restaurant's running account with Yulo — every rupee it is owed or owes, one row per
// event, in PAISE. The weekly settlement (B8) is just the sum of a restaurant's unsettled rows
// whose `eligibleAt` falls in the week; nothing is ever paid out that isn't backed by a row here.
//
//   order_earning        credit  — a delivery/takeaway order paid online, delivered (or
//                                  cancelled by the customer after the kitchen started): the
//                                  restaurant's net from services/settlementMath.service.js
//   dine_in_earning      credit  — a dine-in bill the guest paid online
//   counter_platform_fee debit   — a dine-in bill paid at the counter: the platform fee plus
//                                  the settlement charge on it, owed to Yulo
//   refund_gateway_fee   debit   — Razorpay's fee on a payment that was refunded (B5)
//   adjustment           either  — a manual correction or penalty by an admin (B8)
//   carry_forward        either  — a negative week rolled into the next one (B8)
//
// Rows are append-only facts: corrections are new rows, never edits. One event can only ever
// produce one row — the partial unique indexes below make a retried hook or a replayed webhook
// a no-op instead of a double credit.
const ledgerEntrySchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    type: {
      type: String,
      enum: ['order_earning', 'dine_in_earning', 'counter_platform_fee', 'refund_gateway_fee', 'adjustment', 'carry_forward'],
      required: true,
    },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    // Always positive; `direction` carries the sign.
    amountPaise: { type: Number, required: true, min: 0, validate: Number.isInteger },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: undefined },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: undefined },
    // The full settlement line the amount came from (computeRestaurantSettlementLine) — kept
    // with the row so a statement can always show how it was reached.
    breakdown: { type: mongoose.Schema.Types.Mixed, default: null },
    // When the money counts for settlement. For online money that is when it CLEARED (B12):
    // the later of the event (delivered / bill paid / cancelled after prep) and Razorpay's T+2
    // working-day settlement to Yulo (utils/workingDays.js) — so a row joins the statement of the
    // week it clears in. Counter rows, fees and adjustments count from the event itself.
    eligibleAt: { type: Date, required: true },
    // Equal to eligibleAt; kept as its own field so the screens can say "clears on …" and a
    // backfill can tell rows priced before clearing existed (null) from current ones.
    clearsAt: { type: Date, default: null },
    // Set once a weekly settlement claims this row (B8). Null = not yet settled.
    settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestaurantSettlement', default: null },
    // Who caused it: null for the system, an admin's id for a manual adjustment.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerEntrySchema.index(
  { type: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: 'objectId' } } }
);
ledgerEntrySchema.index(
  { type: 1, billId: 1 },
  { unique: true, partialFilterExpression: { billId: { $type: 'objectId' } } }
);
ledgerEntrySchema.index({ restaurantId: 1, eligibleAt: -1 });
ledgerEntrySchema.index({ restaurantId: 1, settlementId: 1, eligibleAt: 1 });
// A settlement's own rows (generation re-totals, the settlement detail and its export).
ledgerEntrySchema.index({ settlementId: 1 });
// The clearance queue: unsettled rows still clearing.
ledgerEntrySchema.index({ settlementId: 1, clearsAt: 1 });

export default mongoose.model('RestaurantLedgerEntry', ledgerEntrySchema);
