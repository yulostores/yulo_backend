import mongoose from 'mongoose';

// The platform's money rules — every rate, fee and switch the payment and settlement code
// reads — as an append-only history of versions.
//
// A version is never edited. Changing anything means inserting a new version with its own
// `effectiveFrom`; the active rules at any moment are the latest version whose effectiveFrom
// has passed. That gives two things settlement depends on:
//   * an order priced last Tuesday can always be explained by the version active last
//     Tuesday, even after the rates move (orders also snapshot what they were charged), and
//   * a change can be scheduled ahead ("platform fee becomes ₹15 from the 1st").
// services/financeSettings.service.js is the only writer; the hooks at the bottom refuse
// in-place updates and deletes from anywhere else.
//
// Units: every money amount is integer PAISE (utils/money.js); percentages are plain
// percent numbers (3.5 = 3.5 %); distances are kilometres.

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const FEE_BEARERS = ['restaurant', 'platform'];

const financeSettingsSchema = new mongoose.Schema(
  {
    // 1, 2, 3… — unique, so two admins saving at once can't both create "version 7".
    version: { type: Number, required: true },
    effectiveFrom: { type: Date, required: true },
    // null for the defaults the system seeds itself.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },

    // ── Taxes ─────────────────────────────────────────────────────────────────
    // GST on food, charged on top of the (GST-exclusive) menu price — GST-registered
    // restaurants only (applied in B3).
    foodGstPercent: { type: Number, required: true },
    // GST on Yulo's own services: platform fee, delivery charge, settlement charge, ads.
    serviceGstPercent: { type: Number, required: true },

    // ── What the customer pays ────────────────────────────────────────────────
    // Flat platform fee per delivery order / dine-in bill, GST-INCLUSIVE.
    customerPlatformFee: { type: Number, required: true },
    // Dine-in: charge the platform fee once per bill, or once per order round.
    dineInPlatformFeeUnit: { type: String, enum: ['bill', 'order'], required: true },
    // Delivery charge per km, GST-EXCLUSIVE (GST at serviceGstPercent is added on top).
    deliveryPerKmRate: { type: Number, required: true },
    // Floor on the GST-exclusive delivery charge.
    deliveryMinCharge: { type: Number, required: true },
    // Distance is rounded UP to a multiple of this many km before pricing (0.1 → 3.14 km
    // is charged as 3.2 km).
    deliveryDistanceRounding: { type: Number, required: true },

    // ── What the restaurant pays ──────────────────────────────────────────────
    // GST-INCLUSIVE percentage charged to the restaurant on every settled order.
    settlementChargePercent: { type: Number, required: true },
    // What that percentage is taken of: the full amount the customer paid, or only the
    // restaurant's share of it.
    settlementChargeBase: { type: String, enum: ['customer_total', 'restaurant_share'], required: true },

    // ── Payment switches ──────────────────────────────────────────────────────
    codEnabled: { type: Boolean, required: true },

    // ── Rider pay ─────────────────────────────────────────────────────────────
    // Flat pay covering the first riderBaseKm km of a delivery…
    riderBasePay: { type: Number, required: true },
    riderBaseKm: { type: Number, required: true },
    // …then this much per km beyond it.
    riderPerKmRate: { type: Number, required: true },

    // ── Settlement cycle & payouts ────────────────────────────────────────────
    settlementCycle: {
      weekStartsOn: { type: String, enum: DAYS, required: true },
      // IANA zone the week boundaries are drawn in.
      timezone: { type: String, required: true },
    },
    payoutDayOfWeek: { type: String, enum: DAYS, required: true },
    // A week whose deductions exceed its earnings is carried into the next week's
    // settlement instead of being chased as a debt.
    carryForwardNegative: { type: Boolean, required: true },
    // How approved settlements are paid: 'bank_file' — a bulk-payment file uploaded to the
    // company's net banking each week (services/payoutProviders/bankFile.provider.js);
    // 'manual' — paid by any other means and marked paid with a UTR. razorpayx/route reserved for
    // when one of those is activated.
    payoutProvider: { type: String, enum: ['manual', 'bank_file', 'razorpayx', 'route'], required: true },
    // Which bank's bulk-upload layout the payout file uses (config/bankFileFormats.js).
    // Versions saved before this existed read as 'generic_csv'.
    payoutBankFileFormat: { type: String, default: 'generic_csv' },

    // ── Refunds ───────────────────────────────────────────────────────────────
    // Who absorbs Razorpay's (non-refundable) fee when an order is fully refunded, per cause.
    refundFeeBorneBy: {
      restaurant_reject: { type: String, enum: FEE_BEARERS, required: true },
      approval_timeout: { type: String, enum: FEE_BEARERS, required: true },
      customer_cancel_before_accept: { type: String, enum: FEE_BEARERS, required: true },
      restaurant_cancel_after_accept: { type: String, enum: FEE_BEARERS, required: true },
    },
    // Share of the amount refunded when the customer cancels after the kitchen started.
    customerCancelAfterPreparationRefundPercent: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

financeSettingsSchema.index({ version: 1 }, { unique: true });
financeSettingsSchema.index({ effectiveFrom: -1, version: -1 });

// History is immutable. Each of these is a way to rewrite or remove an existing version;
// all of them are refused here so no code path (or console session through the model) can
// quietly change the rules an old order was priced under.
const refuse = function refuseMutation(next) {
  next(new Error('FinanceSettings versions are immutable — create a new version instead'));
};
financeSettingsSchema.pre('save', function blockResave(next) {
  if (!this.isNew) return refuse(next);
  next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  financeSettingsSchema.pre(op, refuse);
}

export const FINANCE_DAYS = DAYS;
export const FINANCE_FEE_BEARERS = FEE_BEARERS;

export default mongoose.model('FinanceSettings', financeSettingsSchema);
