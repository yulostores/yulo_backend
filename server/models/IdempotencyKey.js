import mongoose from 'mongoose';

// Client-supplied Idempotency-Key headers for order placement — "this exact request was
// already handled; here is what it produced". Claimed by INSERTING a row first: the unique
// index lets exactly one of two simultaneous requests with the same key win (the atomic
// equivalent of Redis SET NX), and unlike Redis it keeps working when Redis is down and is
// shared by every server instance. Rows expire after 24 h.
//
//   pending — the winning request is still creating the order; a duplicate gets 409
//   done      — resultId is the order it created; a duplicate gets that order back
const idempotencyKeySchema = new mongoose.Schema(
  {
    scope: { type: String, required: true },
    key: { type: String, required: true },
    status: { type: String, enum: ['pending', 'done'], default: 'pending' },
    resultId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
  },
  { versionKey: false }
);

idempotencyKeySchema.index({ scope: 1, key: 1 }, { unique: true });

export default mongoose.model('IdempotencyKey', idempotencyKeySchema);
