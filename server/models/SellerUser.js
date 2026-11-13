import mongoose from 'mongoose';
import { SELLER_ROLES, GENDERS } from '../config/coupon.config.js';

// A person who logs in to the seller portal for one Seller. Each person has their own row and
// credentials — owners, managers and employees alike — so every redemption can be traced to the
// individual who made it (Coupon.redeemedBy).
//
//   owner     everything, including buying plans, the agreement and managing managers
//   manager   the same business and coupon data as the owner; manages employees only
//   employee  coupon redemption only
//
// sessionVersion works as on StaffMember: bumping it ends every session that user holds
// (deactivation, role change, seller suspended).

const sellerUserSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    experienceYears: { type: Number, min: 0, max: 80, default: null },
    role: { type: String, enum: SELLER_ROLES, required: true },
    isActive: { type: Boolean, default: true },
    // Set when an owner removes this person (onboarding employee list, or team management).
    // A removed row stays inactive for good — approving the seller activates everyone else, so
    // "inactive because the seller isn't approved yet" and "inactive because removed" must differ.
    removedAt: { type: Date, default: null },
    sessionVersion: { type: Number, default: 0 },
    passwordHash: { type: String, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One active login per phone per seller. A deactivated row keeps its phone, so the same
// person can be added again later without colliding with their old record.
sellerUserSchema.index(
  { sellerId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);
sellerUserSchema.index({ phone: 1 });
sellerUserSchema.index({ sellerId: 1, role: 1 });

sellerUserSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

export default mongoose.model('SellerUser', sellerUserSchema);
