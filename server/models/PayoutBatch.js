import mongoose from 'mongoose';

// A weekly bank bulk-payment run (B9, bank-file payouts): the approved settlements an admin
// pays in one net-banking upload. services/payoutBatch.service.js creates it (claiming each
// settlement approved → processing), builds the file, and reconciles the bank's results.
//
// status:
//   created               settlements claimed, file not downloaded yet
//   downloaded            file downloaded at least once (assume it may have been uploaded)
//   partially_reconciled  some results entered, some payments still awaiting the bank
//   reconciled            every payment in it is paid or failed
//   cancelled             withdrawn before upload — its settlements went back to approved
const payoutBatchSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['bank_file'], default: 'bank_file' },
    format: { type: String, required: true },
    status: {
      type: String,
      enum: ['created', 'downloaded', 'partially_reconciled', 'reconciled', 'cancelled'],
      default: 'created',
    },
    settlementIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'RestaurantSettlement' }],
    count: { type: Number, default: 0 },
    totalPaise: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    downloads: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      },
    ],
    reconciledAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

payoutBatchSchema.index({ createdAt: -1 });
payoutBatchSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('PayoutBatch', payoutBatchSchema);
