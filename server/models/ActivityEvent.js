import mongoose from 'mongoose';
import { EVENT_TYPES, RETENTION, TEXT_LIMITS } from '../config/liveActivity.config.js';

// One entry on a live session's timeline. Written only by the server; `data` holds a fixed set
// of small fields — never free-form client input — and nothing that identifies the customer
// beyond the ids.

const DAY = 24 * 60 * 60 * 1000;

/** When an event should be deleted: RETENTION.eventDays after it happened. */
export const eventExpiresAt = (at) => new Date(new Date(at).getTime() + RETENTION.eventDays * DAY);

const activityEventSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerSession', required: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    label: { type: String, required: true, maxlength: 120 },
    data: {
      menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
      itemName: { type: String, maxlength: 120 },
      qty: { type: Number },
      deltaQty: { type: Number },
      totalPaise: { type: Number },
      query: { type: String, maxlength: TEXT_LIMITS.menuQueryMax },
      offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Discount' },
      orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    },
    at: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  // `at` is the event's own time (from utils/clock.js); no createdAt/updatedAt needed.
  { timestamps: false, strict: 'throw' }
);

activityEventSchema.pre('validate', function setExpiry() {
  if (this.at && !this.expiresAt) this.expiresAt = eventExpiresAt(this.at);
});

// Timeline, newest first, paged backwards.
activityEventSchema.index({ sessionId: 1, at: -1 });
activityEventSchema.index({ restaurantId: 1, at: -1 });
activityEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ActivityEvent', activityEventSchema);
