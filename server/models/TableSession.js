import mongoose from 'mongoose';

const tableSessionSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
    waiterId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember' },
    // Who is sitting at this table, when they have no account. Set through the public
    // QR-ordering flow (and fillable by a waiter opening the session on their behalf) —
    // contact details for the receipt/kitchen/floor, never used for auth.
    //
    // These are the guest-side half of one identity contract: an order snapshots them
    // onto Order.customerName/customerPhone exactly as a signed-in customer's order
    // snapshots User.name/User.phone, so every staff screen asks "who ordered" once and
    // gets an answer in the same shape no matter which door the order came through.
    //
    // Backfilled onto the session by services/guestOrder.service.js when a later order in
    // the same sitting supplies details the first one didn't — previously they were only
    // ever written at session creation, so a guest who gave their number on their second
    // round had it silently dropped.
    guestName: { type: String },
    guestPhone: { type: String },
    orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
    batchCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['open', 'bill_requested', 'paid', 'cancelled'],
      default: 'open',
    },
    guestCount: { type: Number, default: 1 },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
  },
  { timestamps: true }
);

tableSessionSchema.index({ tableId: 1, status: 1 });
tableSessionSchema.index({ restaurantId: 1, status: 1 });

export default mongoose.model('TableSession', tableSessionSchema);
