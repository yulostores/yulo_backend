import mongoose from 'mongoose';

// A coupon partner subscription plan on sale (Basic / Plus / Premium). Editable by the super
// admin, but an edit only affects purchases made after it: every SellerSubscription stores a
// snapshot of the plan it bought, so a seller's allocation never changes under them.
//
// basePricePaise is GST-EXCLUSIVE; the price a seller pays is base + gstPercent of base
// (utils/couponPricing.js#planTotals).

const couponPlanSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    basePricePaise: { type: Number, required: true, min: 0, validate: Number.isInteger },
    gstPercent: { type: Number, required: true, min: 0, max: 28 },
    // Coupons the seller's customers can receive.
    couponAllocation: { type: Number, required: true, min: 1, validate: Number.isInteger },
    // Extra coupons reserved for Yulo team members — super admin only.
    complimentaryCount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

couponPlanSchema.index({ key: 1 }, { unique: true });

export default mongoose.model('CouponPlan', couponPlanSchema);
