import mongoose from 'mongoose';

// Powers the "What's on your mind?" quick-filter row on the customer Home feed.
// Replaces the hardcoded arrays that used to live in home.service.js; seeded once
// via scripts/seedQuickFilterChips.js, which uploads each icon to Cloudinary and
// stores only the resulting secure URL here.
const quickFilterChipSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    queryParam: { type: String, required: true },
    iconUrl: { type: String, default: null },
    iconPublicId: { type: String, default: null },
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // Veg-mode overrides, applied when the Home feed is requested with vegMode on.
    // Set only where the chip actually changes (Butter Chicken -> Paneer); any
    // unset field falls back to the standard value above.
    veg: {
      label: { type: String, default: null },
      queryParam: { type: String, default: null },
      iconUrl: { type: String, default: null },
      iconPublicId: { type: String, default: null },
    },
  },
  { timestamps: true }
);

quickFilterChipSchema.index({ isActive: 1, displayOrder: 1 });

export default mongoose.model('QuickFilterChip', quickFilterChipSchema);
