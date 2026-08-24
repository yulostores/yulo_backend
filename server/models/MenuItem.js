import mongoose from 'mongoose';
import mongooseLeanVirtuals from 'mongoose-lean-virtuals';

const menuItemSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCategory' },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    image: { type: String },
    prepTime: { type: Number },
    foodType: { type: String, enum: ['veg', 'non_veg', 'egg'], required: true },
    sellingPrice: { type: Number, required: true, min: 0 },
    discountedPrice: { type: Number, default: null },
    ingredients: [String],
    isAvailable: { type: Boolean, default: true },
    // Free-form tags for menu/search cards (e.g. "bestseller", "highly_reordered") —
    // no dedicated boolean existed to replace; populated once search/home (prompts 7-8)
    // have something to put here.
    badges: [String],
    // Points from a non-veg item to its veg substitute (e.g. "Hyderabadi Biryani" ->
    // "Veg Hyderabadi Biryani"), so veg-mode menu serving can swap one for the other at
    // the same catalog position instead of just hiding the non-veg item. Opt-in per pair,
    // set by the owner only when a real veg alternative exists — never auto-generated.
    // Deliberately not restaurant-scoped or existence-checked at this layer (see the
    // owner menu-item controller) — the same way categoryId/subCategoryId aren't either;
    // the actual substitution *lookup* is prompt 8's job, not this one.
    vegVariantId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
  },
  { timestamps: true }
);

menuItemSchema.virtual('effectivePrice').get(function () {
  return this.discountedPrice ?? this.sellingPrice;
});

menuItemSchema.set('toJSON', { virtuals: true });
menuItemSchema.set('toObject', { virtuals: true });
// Callers across cart/order/menu services fetch this model with `.lean({ virtuals: true })`
// expecting `effectivePrice` to come along — plain `.lean()` skips virtuals entirely, so
// without this plugin that option silently does nothing and effectivePrice is undefined.
menuItemSchema.plugin(mongooseLeanVirtuals);

menuItemSchema.index({ restaurantId: 1, categoryId: 1 });
menuItemSchema.index({ restaurantId: 1, isAvailable: 1 });
menuItemSchema.index({ name: 'text' });

export default mongoose.model('MenuItem', menuItemSchema);
