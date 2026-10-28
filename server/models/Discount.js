import mongoose from 'mongoose';
import { OFFER_STATUSES } from '../config/liveActivity.config.js';

const discountSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    type: {
      type: String,
      enum: ['percentage', 'flat_amount', 'free_item', 'tablewise'],
      required: true,
    },
    offerName: { type: String, required: true },
    code: { type: String, default: null },
    // Cloudinary secure URL of the offer artwork (yulostores/discounts/<restaurantId>),
    // uploaded with the create/update request as the `image` file part.
    image: { type: String, default: null },
    percentage: { type: Number, default: null },
    flatAmount: { type: Number, default: null },
    freeItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    freeItemName: { type: String, default: null },
    applicableTableNumbers: [String],
    applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
    applicableSubCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' }],
    applicableItems: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' }],
    minimumOrderValue: { type: Number, default: 0 },
    applicableTo: { type: String, enum: ['dine_in', 'delivery', 'both'], default: 'both' },
    startDate: { type: Date },
    endDate: { type: Date },
    status: { type: String, enum: ['draft', 'active', 'expired'], default: 'draft' },
    // Opt-in flag for the customer home feed's banner (services/home.service.js) — still
    // a normal per-restaurant discount underneath (restaurantId stays required); "featured"
    // just means "eligible to surface as the Home banner" when active and nearby, not a
    // separate platform-wide discount type.
    isFeatured: { type: Boolean, default: false },

    // ── Personal offers (live customer activity) ──────────────────────────────
    // `kind: 'personal'` is one owner-sent offer for one signed-in customer, from the live
    // dashboard (services/personalOffer.service.js). Rows written before this field existed
    // have no `kind`, so every public/promo query filters `kind: { $ne: 'personal' }` —
    // never `kind: 'public'`. Personal offers have no `code`, are delivery-only, restaurant-
    // funded like any discount, and redeemable once. `status` is kept in step with
    // `offerStatus` (active while open, expired once expired / revoked / redeemed) so code
    // that only reads `status` never treats a closed personal offer as live.
    kind: { type: String, enum: ['public', 'personal'], default: 'public' },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerSession', default: null },
    // Rupees, like percentage / flatAmount: the most this offer can take off.
    maxDiscountAmount: { type: Number, default: null },
    maxRedemptions: { type: Number, default: null },
    redemptionCount: { type: Number, default: 0 },
    offerStatus: { type: String, enum: OFFER_STATUSES, default: null },
    // Backs the one-open-offer-per-customer index below; true only for sent → applied.
    isOpen: { type: Boolean, default: false },
    deliveredAt: { type: Date, default: null },
    viewedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    redeemedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

discountSchema.index({ restaurantId: 1, status: 1 });
// One code per restaurant. Partial on string codes: the old `sparse` version of this compound
// index still indexed `code: null` (restaurantId is always present), so a restaurant could
// never hold two code-less offers. Named, because the old index has the same key pattern —
// scripts/fixDiscountCodeIndex.js drops the old one on existing databases.
discountSchema.index(
  { code: 1, restaurantId: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } }, name: 'code_restaurantId_string_unique' }
);
// Personal offers: a customer's offers at a restaurant, the owner's offer list, at most one
// open offer per customer + restaurant (the real guard — not a read-then-write check), and
// the expiry sweep.
discountSchema.index({ targetUserId: 1, restaurantId: 1, offerStatus: 1, endDate: 1 });
discountSchema.index({ restaurantId: 1, kind: 1, createdAt: -1 });
discountSchema.index(
  { restaurantId: 1, targetUserId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_personal_offer' }
);
discountSchema.index({ kind: 1, isOpen: 1, endDate: 1 });

export default mongoose.model('Discount', discountSchema);
