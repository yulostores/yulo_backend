import mongoose from 'mongoose';
import {
  EVENT_TYPES,
  RETENTION,
  SESSION_STATUSES,
  TEXT_LIMITS,
  isOpenSessionStatus,
} from '../config/liveActivity.config.js';

// One customer's visit to one restaurant, as the owner's live dashboard sees it. Written only by
// the server (services/activity.service.js and its sweeper) — never from a client-sent cart or
// event. Closed sessions (abandoned / ended / converted) never reopen; activity after closing
// starts a new one.

const DAY = 24 * 60 * 60 * 1000;

/** When a session should be deleted: RETENTION.sessionDays after its last activity. */
export const sessionExpiresAt = (lastActivityAt) =>
  new Date(new Date(lastActivityAt).getTime() + RETENTION.sessionDays * DAY);

/**
 * `{ status, isOpen }` for an update query. `isOpen` must always match the status (it backs the
 * one-open-session-per-customer index), and an update query can't run the document hook below,
 * so every writer that changes `status` with updateOne/updateMany/findOneAndUpdate spreads this
 * into its `$set`. Documents saved with create()/save() get it from the hook.
 */
export const sessionStatusFields = (status) => ({ status, isOpen: isOpenSessionStatus(status) });

const cartItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const customerSessionSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isGuest: { type: Boolean, default: false },
    // First name only, "Customer" or "Guest" — never phone or email.
    displayName: { type: String, required: true, maxlength: TEXT_LIMITS.displayNameMax },
    pastOrderCount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: SESSION_STATUSES, default: 'active' },
    isOpen: { type: Boolean, default: true },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    lastEvent: {
      type: { type: String, enum: EVENT_TYPES },
      label: { type: String },
      at: { type: Date },
    },
    cart: {
      items: { type: [cartItemSchema], default: () => [] },
      totalPaise: { type: Number, default: 0, min: 0 },
      updatedAt: { type: Date, default: null },
    },
    // The global search text that led here, only if the customer then opened this restaurant.
    cameFromSearch: { type: String, default: null, maxlength: TEXT_LIMITS.menuQueryMax },
    eventCount: { type: Number, default: 0, min: 0 },
    offerIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Discount', default: () => [] },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    checkoutStartedAt: { type: Date, default: null },
    checkoutLeftAt: { type: Date, default: null },
    // Set when the customer turns activity sharing off: hidden from every owner surface.
    hiddenAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

customerSessionSchema.pre('validate', function syncDerivedFields() {
  this.isOpen = isOpenSessionStatus(this.status);
  if (this.lastActivityAt && (this.isNew || this.isModified('lastActivityAt') || !this.expiresAt)) {
    this.expiresAt = sessionExpiresAt(this.lastActivityAt);
  }
});

// Owner dashboard list. A `hiddenAt`-led variant is added in A4 only if that list query's
// explain() shows it is needed.
customerSessionSchema.index({ restaurantId: 1, status: 1, lastActivityAt: -1 });
// The sweeper looks across every restaurant by status + age, so it needs an index that doesn't
// start with restaurantId; and, for checkout_left, a checkout-start index over open sessions only
// (a small set — closed sessions, the bulk of the collection, are left out).
customerSessionSchema.index({ status: 1, lastActivityAt: 1 });
customerSessionSchema.index({ checkoutStartedAt: 1 }, { partialFilterExpression: { isOpen: true } });
// At most one open session per restaurant + customer.
customerSessionSchema.index(
  { restaurantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { isOpen: true } }
);
// Opting out hides every session of one customer.
customerSessionSchema.index({ userId: 1 });
customerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('CustomerSession', customerSessionSchema);
