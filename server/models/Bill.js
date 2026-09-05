import mongoose from 'mongoose';

const batchItemSchema = new mongoose.Schema(
  {
    name: { type: String },
    quantity: { type: Number },
    price: { type: Number },
    lineTotal: { type: Number },
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    batchNumber: { type: Number },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    items: [batchItemSchema],
    batchTotal: { type: Number },
    placedAt: { type: Date },
  },
  { _id: false }
);

const discountAppliedSchema = new mongoose.Schema(
  {
    discountId: { type: mongoose.Schema.Types.ObjectId },
    code: { type: String },
    description: { type: String },
    amount: { type: Number },
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    tableSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    batches: [batchSchema],
    subtotal: { type: Number, required: true },
    gstPercent: { type: Number },
    gstAmount: { type: Number },
    serviceChargePercent: { type: Number },
    serviceChargeAmount: { type: Number },
    discountsApplied: [discountAppliedSchema],
    grandTotal: { type: Number, required: true },
    status: { type: String, enum: ['open', 'paid', 'cancelled'], default: 'open' },
    paidAt: { type: Date },
    paidBy: { type: String, enum: ['cash', 'upi', 'card', 'online'] },
    // Razorpay order id — set when a guest starts paying this bill online (see
    // controllers/publicBill.controller.js), read back by the verify endpoint and the
    // webhook to confirm a submitted payment actually belongs to this bill.
    paymentIntentId: { type: String, default: null },
    // The actual captured payment's own id, distinct from the order id above — set once
    // payment succeeds, same split as Order.razorpayPaymentId/paymentIntentId.
    razorpayPaymentId: { type: String, default: null },
  },
  { timestamps: true }
);

billSchema.index({ tableSessionId: 1 });
billSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });

export default mongoose.model('Bill', billSchema);
