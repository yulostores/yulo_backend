import mongoose from 'mongoose';

const adminActivityLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true },
    targetType: {
      type: String,
      enum: ['restaurant', 'user', 'delivery_partner', 'ticket', 'order', 'payout', 'finance_settings', 'settlement', 'payout_batch'],
      required: true,
    },
    // Optional: bulk actions (e.g. marking many payouts paid at once) don't have a
    // single target — the affected ids live in `metadata` instead.
    targetId: { type: mongoose.Schema.Types.ObjectId },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

adminActivityLogSchema.index({ targetType: 1, targetId: 1 });

export default mongoose.model('AdminActivityLog', adminActivityLogSchema);
