import mongoose from 'mongoose';

// Guest assistance requests raised from a table (call waiter, need water, need the
// bill, …) — see API-GAPS.md and src/screens/shared/RequestsBoard.jsx on the frontend.
const requestSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
    // Linked when the table has an open dine-in session at the time the request is
    // raised — null for a request raised between sessions (still useful: staff still
    // need to know which table is asking).
    tableSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null },
    // Set when the guest happens to be signed in — never required, since raising "need
    // water" shouldn't be gated behind the OTP login that ordering requires.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    type: {
      type: String,
      enum: ['call_waiter', 'water', 'bill', 'other'],
      required: true,
    },
    note: { type: String, default: '', maxlength: 280 },
    status: {
      type: String,
      enum: ['pending', 'acknowledged', 'resolved'],
      default: 'pending',
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

requestSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
requestSchema.index({ restaurantId: 1, tableId: 1, createdAt: -1 });

export default mongoose.model('Request', requestSchema);
