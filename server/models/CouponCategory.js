import mongoose from 'mongoose';

// A business category coupons are grouped by (Salon, Spa, Grocery Store…). `enabled` is the
// super admin's toggle: after a paid food order a customer receives coupons only from enabled
// categories, at most one per category (services/couponIssue.service.js, CB6).

const couponCategorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    icon: { type: String, default: null },
    enabled: { type: Boolean, default: false },
    // Issue order when a customer earns coupons from several categories at once.
    sortOrder: { type: Number, default: 0 },
    // This category's own partner agreement. version 0 = none: sellers in the category then sign
    // the general one (CouponSettings.agreementText). Publishing again bumps the version, which
    // asks every seller in the category to accept the new text (services/sellerAccount.service.js).
    agreement: {
      version: { type: Number, default: 0 },
      text: { type: String, default: '' },
      updatedAt: { type: Date, default: null },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
  },
  { timestamps: true }
);

couponCategorySchema.index({ key: 1 }, { unique: true });
couponCategorySchema.index({ enabled: 1, sortOrder: 1 });

export default mongoose.model('CouponCategory', couponCategorySchema);
