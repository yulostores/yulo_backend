import mongoose from 'mongoose';

// Ticket lifecycle. `in_progress` and `closed` are the pre-B12 values: still accepted on input
// and still valid in the schema (a document not yet migrated must keep saving), but every write
// stores the new vocabulary — see the pre-validate hook below and
// scripts/migrateTicketStatuses.js. Customer and rider responses keep speaking the old one
// (services/supportTicket.service.js legacyStatus) so their apps don't change.
export const TICKET_STATUSES = ['open', 'in_review', 'awaiting_restaurant', 'resolved'];
export const LEGACY_TICKET_STATUS = { in_progress: 'in_review', closed: 'resolved' };

// A restaurant's report about its money (B12 task 5): what the Payment issues screens are built
// on. General tickets (customer, rider, owner "other") keep kind 'general' and none of these.
export const PAYMENT_ISSUE_TYPES = ['payout_not_received', 'wrong_deduction', 'missing_order'];

// A file attached to the report or to a reply: a bank-statement page, a screenshot. Stored on
// Cloudinary like the restaurant's compliance documents (same raw-for-PDF rule), served back
// through the API — the URL is never handed out.
const ticketAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String, required: true },
    publicId: { type: String, default: null },
    resourceType: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now },
    uploadedByType: { type: String, enum: ['admin', 'user'], required: true },
  },
  { _id: true }
);

const supportTicketMessageSchema = new mongoose.Schema(
  {
    senderType: { type: String, enum: ['admin', 'user'] },
    sender: { type: mongoose.Schema.Types.ObjectId },
    text: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
    // An admin message asking the restaurant for more information (moves the ticket to
    // awaiting_restaurant) — the owner's panel highlights it.
    requestsInformation: { type: Boolean, default: false },
    // Something that looked like a full account / card number or an OTP was masked out.
    redacted: { type: Boolean, default: false },
    attachments: { type: [ticketAttachmentSchema], default: [] },
  },
  { _id: true }
);

const supportTicketSchema = new mongoose.Schema(
  {
    raisedByType: {
      type: String,
      enum: ['owner', 'customer', 'delivery_partner'],
      required: true,
    },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant' },
    // Optional context for a customer ticket raised about a specific order (screen 26's
    // categories are largely order-scoped), and for a payment issue about one order.
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    category: {
      type: String,
      // The original 4 (+'other') were owner/delivery_partner-facing; the next 4 are the
      // customer app's fixed Help & Support rows (screen 26); 'payout' is a restaurant payment
      // issue (kind 'payment') — one model rather than parallel schemas.
      enum: [
        'billing', 'technical', 'account', 'delivery', 'other',
        'order_delayed', 'wrong_missing_items', 'veg_fleet_issue', 'payment_refund',
        'payout',
      ],
      default: 'other',
    },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: {
      type: String,
      enum: [...TICKET_STATUSES, ...Object.keys(LEGACY_TICKET_STATUS)],
      default: 'open',
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    messages: [supportTicketMessageSchema],

    // ── Payment issues (B12) ─────────────────────────────────────────────────────
    kind: { type: String, enum: ['general', 'payment'], default: 'general' },
    // YP-YYYYMMDD-NNN, payment issues only (scripts and the screens quote it to the owner).
    ticketNumber: { type: String, default: undefined },
    issueType: { type: String, enum: [...PAYMENT_ISSUE_TYPES, null], default: null },
    settlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'RestaurantSettlement', default: null },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },
    contactEmail: { type: String, default: null },
    contactPhone: { type: String, default: null },
    // The report's own attachments (replies carry theirs on the message).
    attachments: { type: [ticketAttachmentSchema], default: [] },
    descriptionRedacted: { type: Boolean, default: false },
    // Progress steps on both portals: Issue submitted (createdAt) → Awaiting review (reviewedAt)
    // → Support response (firstResponseAt) → Issue resolved (resolvedAt).
    reviewedAt: { type: Date, default: null },
    firstResponseAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },
  },
  { timestamps: true }
);

// Every write stores the new status vocabulary, whatever the caller (or an old document) said.
supportTicketSchema.pre('validate', function normaliseStatus(next) {
  if (LEGACY_TICKET_STATUS[this.status]) this.status = LEGACY_TICKET_STATUS[this.status];
  next();
});

supportTicketSchema.index({ status: 1 });
supportTicketSchema.index({ priority: 1 });
supportTicketSchema.index({ kind: 1, status: 1, createdAt: -1 });
supportTicketSchema.index({ restaurantId: 1, kind: 1, createdAt: -1 });
supportTicketSchema.index({ settlementId: 1 }, { partialFilterExpression: { settlementId: { $type: 'objectId' } } });
supportTicketSchema.index({ ticketNumber: 1 }, { unique: true, partialFilterExpression: { ticketNumber: { $type: 'string' } } });

export default mongoose.model('SupportTicket', supportTicketSchema);
