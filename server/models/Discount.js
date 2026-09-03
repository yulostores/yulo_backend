import mongoose from 'mongoose';

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
  },
  { timestamps: true }
);

discountSchema.index({ restaurantId: 1, status: 1 });
discountSchema.index({ code: 1, restaurantId: 1 }, { unique: true, sparse: true });

export default mongoose.model('Discount', discountSchema);
