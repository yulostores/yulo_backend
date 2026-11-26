import mongoose from 'mongoose';
import { OFFER_STATUSES } from '../config/coupon.config.js';

// What a seller's coupon actually gives the customer ("20% off any haircut"). Written by the
// seller, approved by a super admin before it can be issued. A coupon copies the offer it was
// issued from by reference; editing an approved offer sends it back to review (CB5), so a
// customer never holds a coupon whose terms changed without review.
//
//   draft → pending_review → approved ⇄ paused
//                          ↘ rejected → (edited) → pending_review

const couponOfferSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponCategory', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    terms: { type: String, trim: true, maxlength: 2000, default: '' },
    // null → CouponSettings.defaultValidityDays at issue time.
    validityDays: { type: Number, min: 1, max: 365, default: null },
    // Who the offer is for. A customer gets it only when they match: their gender ('all' = both),
    // and their age on the day of issue within [ageMin, ageMax] (either end optional). A
    // customer whose gender / date of birth isn't known only gets offers that don't need it.
    targetGender: { type: String, enum: ['all', 'male', 'female'], default: 'all' },
    ageMin: { type: Number, min: 10, max: 100, default: null },
    ageMax: { type: Number, min: 10, max: 100, default: null },
    status: { type: String, enum: OFFER_STATUSES, default: 'draft' },
    rejectionReason: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerUser', default: null },
  },
  { timestamps: true }
);

couponOfferSchema.index({ sellerId: 1, status: 1 });
couponOfferSchema.index({ categoryId: 1, status: 1 });

export default mongoose.model('CouponOffer', couponOfferSchema);
