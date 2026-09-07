import mongoose from 'mongoose';

const selectedOptionSchema = new mongoose.Schema(
  { optionId: { type: mongoose.Schema.Types.ObjectId, required: true }, qty: { type: Number, default: 1 } },
  { _id: false }
);

const cartItemSchema = new mongoose.Schema({
  menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
  // Snapshots at add-time — never re-read from MenuItem afterward, same "price never
  // changes after placement" convention Order.js already uses for order line items.
  name: { type: String, required: true },
  unitPrice: { type: Number, required: true },
  qty: { type: Number, required: true, min: 1 },
  // Snapshot of MenuItem.foodType at add-time — the cart screen shows a veg/non-veg
  // mark per line and colours its checkout CTA green only when every line is 'veg',
  // without a MenuItem round-trip. Optional so lines added before this field existed
  // still load; buildCartResponse backfills those from MenuItem on read.
  foodType: { type: String, enum: ['veg', 'non_veg', 'egg'] },
  selectedOptions: [selectedOptionSchema],
});

const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // null when the cart is empty — set to the first item's restaurant on first add,
    // cleared back to null whenever the cart empties out (see services/cart.service.js's
    // resetIfEmpty) so a later add from a different restaurant doesn't spuriously conflict
    // against a cart that has no actual items left in it.
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', default: null },
    items: [cartItemSchema],
    appliedDiscountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Discount', default: null },
  },
  { timestamps: true }
);

export default mongoose.model('Cart', cartSchema);
