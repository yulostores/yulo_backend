import mongoose from 'mongoose';
import { SELLER_STATUSES, SELLER_DOCUMENT_TYPES } from '../config/coupon.config.js';

// A coupon partner: a non-restaurant business (salon, spa, grocery…) that buys a plan and
// whose coupons Yulo hands to customers after a paid food order. Deliberately its own model,
// not a kind of Restaurant — it has no menu, orders or settlement, and Restaurant.plan is an
// unrelated field. Its people log in as SellerUser rows (owner / manager / employee).
//
// Identity numbers follow the bank-account rule (Restaurant.payoutAccount): stored ONLY
// encrypted (utils/fieldEncryption.js), select:false so no ordinary query returns them, with
// the last 4 digits kept in clear for display. For Aadhaar only the last 4 is required; the
// full number is encrypted if it is stored at all (§ Business rules — Aadhaar).

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite),
        message: 'coordinates must be [longitude, latitude]',
      },
    },
  },
  { _id: false }
);

const sellerDocumentSchema = new mongoose.Schema({
  type: { type: String, enum: SELLER_DOCUMENT_TYPES, required: true },
  url: { type: String },
  name: { type: String },
  mimeType: { type: String },
  // Cloudinary identity, as on restaurant documents — needed to delete or sign a download.
  publicId: { type: String },
  resourceType: { type: String, enum: ['image', 'raw'], default: 'image' },
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  uploadedAt: { type: Date, default: Date.now },
});

const sellerSchema = new mongoose.Schema(
  {
    // ── Business ─────────────────────────────────────────────────────────────
    businessName: { type: String, required: true, trim: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponCategory', required: true },
    gstNumber: { type: String, uppercase: true, trim: true, default: null },
    address: {
      line1: { type: String, trim: true, default: null },
      line2: { type: String, trim: true, default: null },
      city: { type: String, trim: true, default: null },
      state: { type: String, trim: true, default: null },
      pincode: { type: String, trim: true, default: null },
    },
    // Own sub-schema with no default: "no location yet" (a seller mid-onboarding) is the
    // absence of the field, never an empty Point the 2dsphere index would refuse.
    location: { type: pointSchema, default: undefined },
    businessPhone: { type: String, trim: true, default: null },
    establishedOn: { type: Date, default: null },

    // ── Owner ────────────────────────────────────────────────────────────────
    owner: {
      name: { type: String, trim: true, default: null },
      dateOfBirth: { type: Date, default: null },
      phone: { type: String, trim: true, default: null },
      panEncrypted: { type: String, default: null, select: false },
      panLast4: { type: String, default: null },
      aadhaarEncrypted: { type: String, default: null, select: false },
      aadhaarLast4: { type: String, default: null },
    },

    documents: [sellerDocumentSchema],

    // ── Review ───────────────────────────────────────────────────────────────
    status: { type: String, enum: SELLER_STATUSES, default: 'pending' },
    submittedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },

    // The partner agreement the owner accepted: the general one (CouponSettings.agreementVersion)
    // or its category's own (CouponCategory.agreement.version) — `scope` says which; an acceptance
    // from before category agreements existed has none and was of the general one.
    agreement: {
      scope: { type: String, enum: ['general', 'category', null], default: null },
      categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponCategory', default: null },
      version: { type: Number, default: null },
      acceptedAt: { type: Date, default: null },
      acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerUser', default: null },
      ip: { type: String, default: null },
    },

    // Prepaid reminder-SMS credits (1 credit = 1 SMS). Only ever changed by atomic $inc with a
    // guard, so parallel sends can never take it below zero.
    smsCreditsBalance: { type: Number, default: 0, min: 0 },
    // The credit purchases already added to the balance. The add is one conditional update
    // ({ _id, smsCreditPurchaseIds: { $ne: id } } → $inc + $push), so a purchase can never be
    // credited twice, however many times its payment is confirmed.
    smsCreditPurchaseIds: { type: [mongoose.Schema.Types.ObjectId], default: [], select: false },
  },
  { timestamps: true }
);

sellerSchema.index({ status: 1, createdAt: -1 });
sellerSchema.index({ categoryId: 1, status: 1 });
sellerSchema.index({ location: '2dsphere' });

export default mongoose.model('Seller', sellerSchema);
