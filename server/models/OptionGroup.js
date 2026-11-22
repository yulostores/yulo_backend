import mongoose from 'mongoose';

// Options keep their default auto-generated _id — selections reference it directly
// (see services/pricing.service.js's `selections: [{ groupId, optionId, qty }]`).
const optionSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String },
  priceDeltaMinor: { type: Number, default: 0 },
  // >1 only meaningful for 'addons' groups — this is what lets e.g. "Extra butter
  // dollop" be added ×2, ×3 with its own quantity stepper, distinct from a
  // single_choice group where you're picking one option, not "how many".
  maxQty: { type: Number, default: 1 },
  isDefaultSelected: { type: Boolean, default: false },
});

// One unified schema for both customization patterns in the Figma export: a required
// single-select attribute group (e.g. "Choice of seasonal veg", some options priced,
// some free) and a multi-select add-ons group where each add-on carries its own quantity
// (e.g. "Extra butter dollop, +₹30 ×2"). `type` is what tells pricing/validation which
// selection rules apply — see services/pricing.service.js's computeItemPrice.
const optionGroupSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: ['single_choice', 'addons'], required: true },
    required: { type: Boolean, default: false },
    // Only meaningful for 'addons' — single_choice is implicitly exactly 1 when
    // required, 0 or 1 otherwise (see computeItemPrice, which derives that rather than
    // reading these two fields for single_choice groups).
    minSelect: { type: Number, default: 0 },
    maxSelect: { type: Number, default: null }, // null = unlimited
    sortOrder: { type: Number, default: 0 },
    options: [optionSchema],
    // 'portion' = the Full/Half plate choice generated from MenuItem.halfPlatePrice
    // (services/portion.service.js). Maintained by the server only; owners edit the prices on
    // the item, never this group directly.
    systemKey: { type: String, enum: ['portion', null], default: null },
  },
  { timestamps: true }
);

optionGroupSchema.index({ menuItemId: 1, sortOrder: 1 });

export default mongoose.model('OptionGroup', optionGroupSchema);
