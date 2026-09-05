import mongoose from 'mongoose';

// Atomic named sequences. The only consumer today is the bill numbering in
// services/billing.service.js: a bill is a receipt the guest keeps and the owner files,
// so it needs a short, human, gapless-per-restaurant identifier that is NOT derived from
// the ObjectId (an ObjectId suffix is neither sequential nor readable over the phone).
//
// Kept generic — `key` is a caller-defined string (e.g. `bill:<restaurantId>`) — so the
// next thing that needs a running number doesn't add a second counter collection.
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

/**
 * Increments `key` and returns its new value. Upserts on first use, so a restaurant's
 * first bill gets 1 without any seeding step.
 */
export const nextSequence = async (key) => {
  const doc = await mongoose.model('Counter').findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

export default mongoose.model('Counter', counterSchema);
