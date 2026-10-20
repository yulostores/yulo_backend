import mongoose from 'mongoose';

// One row per webhook delivery we have accepted, keyed on the provider's own event id
// (Razorpay sends it as the `x-razorpay-event-id` header and repeats it on every retry of the
// same event). Razorpay delivers at-least-once and retries anything that isn't a 2xx, so the
// same event can arrive several times — this is what lets the handler run each one once.
//
// status:
//   processing — claimed by a delivery that is working on it (or crashed mid-way; a later
//                retry re-claims it)
//   processed  — done; further deliveries of this id are acknowledged and skipped
//   ignored    — an event type we accept but don't act on yet (e.g. refunds until B5)
//   failed     — a permanent failure (bad payload, unknown order…); acknowledged so Razorpay
//                stops retrying, kept here with the error for someone to look at
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['razorpay'], required: true },
    eventId: { type: String, required: true },
    // sha256 of the raw body. The event-id header is not covered by Razorpay's signature, so a
    // captured body replayed under a new id would otherwise run again; the body (which IS
    // signed) is the same event whatever header it arrives with.
    bodyHash: { type: String },
    event: { type: String, required: true },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['processing', 'processed', 'ignored', 'failed'],
      default: 'processing',
    },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ status: 1, createdAt: -1 });
webhookEventSchema.index({ provider: 1, bodyHash: 1 }, { unique: true, partialFilterExpression: { bodyHash: { $type: 'string' } } });

export default mongoose.model('WebhookEvent', webhookEventSchema);
