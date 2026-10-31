// Support tickets: the shared helpers behind every portal's ticket endpoints, and the payment
// issues a restaurant raises about its money (B12 task 5 — the super admin's Payment issues
// screens I1–I3 and the owner's report / tracking panels).
//
// Rules the screens rely on:
//   - A ticket never changes a payout's status. This file only ever READS settlements, orders
//     and bills (for the linked-record card).
//   - Status vocabulary: open → in_review → (awaiting_restaurant ⇄ in_review) → resolved.
//     The pre-B12 values in_progress / closed are accepted on input and mapped; customer and
//     rider responses keep the old vocabulary (legacyStatus) so their apps are unchanged.
//   - Anything that looks like a full account or card number, or an OTP, is masked before it
//     is stored — the design tells both sides never to share them, and a ticket is read by
//     many people.
import mongoose from 'mongoose';
import SupportTicket, { LEGACY_TICKET_STATUS, TICKET_STATUSES } from '../models/SupportTicket.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import Restaurant from '../models/Restaurant.js';
import User from '../models/User.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { nextSequence } from '../models/Counter.js';
import * as uploadService from './upload.service.js';
import { streamDocument } from './restaurantDocument.service.js';
import { ApiError } from '../utils/ApiError.js';
import { maskPhone } from '../utils/maskPhone.js';
import { toPaise } from '../utils/money.js';
import logger from '../utils/logger.js';

// ── Status ─────────────────────────────────────────────────────────────────────

/** A status from a request (new or pre-B12 vocabulary) → the stored value, or null. */
export const normaliseStatus = (status) => {
  if (!status) return null;
  if (TICKET_STATUSES.includes(status)) return status;
  return LEGACY_TICKET_STATUS[status] ?? null;
};

/** The pre-B12 vocabulary the customer and rider apps were built on. */
export const legacyStatus = (status) => {
  if (status === 'in_review' || status === 'awaiting_restaurant') return 'in_progress';
  return status; // open, resolved (and an unmigrated in_progress / closed as-is)
};

const STAMP_ON = (ticket, status, now) => {
  if (status !== 'open' && !ticket.reviewedAt) ticket.reviewedAt = now;
  if (status === 'resolved') ticket.resolvedAt = now;
  else ticket.resolvedAt = undefined;
};

// ── Redaction ──────────────────────────────────────────────────────────────────

// 9–19 digits, optionally grouped by spaces or hyphens: bank account numbers (9–18) and card
// numbers (13–19). Kept: the last 4, which is what both sides use to name an account.
const LONG_NUMBER = /(?<![\d])\d(?:[ -]?\d){8,18}(?![\d])/g;
// A short code right after a word that marks it as a secret: "OTP 482913", "otp is: 4829",
// "CVV 123", "PIN-0000", "password 12345678".
const SECRET_CODE = /\b(otp|one[\s-]?time[\s-]?(?:password|code)|cvv|cvc|upi[\s-]?pin|mpin|passcode|password)\b([^\d\n]{0,20})(\d{3,8})(?!\d)/gi;

/** Masks secrets in a free-text message. Returns { text, redacted }. */
export const redactSensitive = (input) => {
  let redacted = false;
  let text = String(input ?? '');
  text = text.replace(SECRET_CODE, (_m, word, gap) => {
    redacted = true;
    return `${word}${gap}[removed]`;
  });
  text = text.replace(LONG_NUMBER, (match) => {
    redacted = true;
    const digits = match.replace(/\D/g, '');
    return `•••• ${digits.slice(-4)}`;
  });
  return { text, redacted };
};

// ── Ticket numbers ────────────────────────────────────────────────────────────

const istDateKey = (at = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
};

/** YP-YYYYMMDD-NNN — a running number per IST day (atomic; at least three digits). */
export const nextTicketNumber = async (at = new Date()) => {
  const day = istDateKey(at);
  const seq = await nextSequence(`ticket:YP:${day}`);
  return `YP-${day}-${String(seq).padStart(3, '0')}`;
};

// ── Attachments ───────────────────────────────────────────────────────────────

export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const ATTACHMENT_MAX_MB = 5;

let uploader = uploadService.uploadBuffer;
/** Tests replace the storage upload (never Cloudinary from a test). Pass undefined to reset. */
export const __setTicketUploaderForTests = (fn) => {
  uploader = fn ?? uploadService.uploadBuffer;
};

/**
 * Stores one uploaded file (multer memory file) and returns the attachment subdocument.
 * PDFs go to Cloudinary's `raw` type with no extension in the public id — the same rule as
 * restaurant compliance documents (see controllers/owner/document.controller.js).
 */
export const storeAttachment = async (file, { restaurantId, uploadedByType }) => {
  if (!file) return null;
  if (!ATTACHMENT_TYPES.includes(file.mimetype)) {
    throw new ApiError(400, 'INVALID_FILE_TYPE', 'Attach a PDF, JPG or PNG');
  }
  if (file.size > ATTACHMENT_MAX_MB * 1024 * 1024) {
    throw new ApiError(400, 'LIMIT_FILE_SIZE', `An attachment can be at most ${ATTACHMENT_MAX_MB} MB`);
  }
  const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image';
  let stored;
  try {
    stored = await uploader({
      buffer: file.buffer,
      folder: `yulostores/tickets/${restaurantId ?? 'general'}`,
      publicId: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      resourceType,
    });
  } catch (err) {
    logger.error({ err: err?.message ?? String(err), restaurantId: String(restaurantId ?? '') }, 'Ticket attachment upload failed');
    throw new ApiError(502, 'UPLOAD_FAILED', 'Sorry, we could not save that file right now. Please try again in a moment.');
  }
  return {
    name: String(file.originalname ?? 'attachment').slice(0, 200),
    mimeType: file.mimetype,
    size: file.size,
    url: stored.secureUrl,
    publicId: stored.publicId ?? null,
    resourceType,
    uploadedAt: new Date(),
    uploadedByType,
  };
};

/** Every attachment on a ticket (report + replies), by id. */
const findAttachment = (ticket, attachmentId) => {
  const all = [...(ticket.attachments ?? []), ...(ticket.messages ?? []).flatMap((m) => m.attachments ?? [])];
  return all.find((a) => String(a._id) === String(attachmentId)) ?? null;
};

/** Streams an attachment back through the API (the storage URL is never handed out). */
export const streamAttachment = async (ticket, attachmentId, res) => {
  const attachment = findAttachment(ticket, attachmentId);
  if (!attachment) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found');
  res.set('Content-Disposition', `inline; filename="${attachment.name.replace(/["\\\r\n]/g, '')}"`);
  return streamDocument({ ...attachment, type: 'ticket_attachment' }, res);
};

const attachmentView = (a) => ({
  _id: a._id,
  name: a.name,
  mimeType: a.mimeType,
  size: a.size,
  uploadedAt: a.uploadedAt,
  uploadedByType: a.uploadedByType,
});

// ── Messages and status changes ───────────────────────────────────────────────

/**
 * Appends a message (with optional attachments) and moves the ticket along:
 *   - an admin message: open → in_review; `requestsInformation` → awaiting_restaurant;
 *     the first admin message stamps firstResponseAt;
 *   - the raiser's message: awaiting_restaurant / resolved → in_review (they answered, or
 *     reopened it); a general ticket that is still open → in_review (pre-B12 behaviour:
 *     any reply on an open ticket starts work on it).
 * Text is redacted before it is stored. Shared by every portal's reply endpoint.
 */
export const addTicketMessage = async (
  ticket,
  { senderType, sender, text, attachments = [], requestsInformation = false }
) => {
  const { text: clean, redacted } = redactSensitive(text);
  const now = new Date();
  ticket.messages.push({
    senderType,
    sender,
    text: clean,
    sentAt: now,
    requestsInformation: senderType === 'admin' && requestsInformation,
    redacted,
    attachments,
  });

  let next = normaliseStatus(ticket.status) ?? 'open';
  if (senderType === 'admin') {
    if (!ticket.firstResponseAt) ticket.firstResponseAt = now;
    if (requestsInformation) next = 'awaiting_restaurant';
    else if (next === 'open') next = 'in_review';
  } else if (next === 'awaiting_restaurant' || next === 'resolved') {
    next = 'in_review';
  } else if (next === 'open' && ticket.kind !== 'payment') {
    next = 'in_review';
  }
  if (next !== ticket.status) {
    ticket.status = next;
    STAMP_ON(ticket, next, now);
  }
  await ticket.save();
  return ticket;
};

/**
 * An admin status change (Mark in review / Resolve ticket / reopen). Asking for information
 * goes through addTicketMessage — it needs a message. Returns the saved ticket.
 */
export const setTicketStatus = async (ticket, status, { resolutionNote } = {}) => {
  const next = normaliseStatus(status);
  if (!next) throw new ApiError(400, 'VALIDATION_ERROR', `status must be one of: ${TICKET_STATUSES.join(', ')}`);
  if (next === 'awaiting_restaurant') {
    throw new ApiError(400, 'MESSAGE_REQUIRED', 'Asking the restaurant for information needs a message — use request-information');
  }
  const now = new Date();
  ticket.status = next;
  STAMP_ON(ticket, next, now);
  if (next === 'resolved' && resolutionNote !== undefined) ticket.resolutionNote = resolutionNote || null;
  await ticket.save();
  return ticket;
};

export const statusCounts = async (filter = {}) => {
  const rows = await SupportTicket.aggregate([
    { $match: filter },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0]));
  for (const { _id, n } of rows) {
    const s = normaliseStatus(_id);
    if (s) counts[s] += n;
  }
  return counts;
};

// ── Linked record (read only) ─────────────────────────────────────────────────

let payoutStatusModule;
const loadPayoutStatus = async () => {
  if (payoutStatusModule !== undefined) return payoutStatusModule;
  try {
    payoutStatusModule = await import('../utils/payoutStatus.js');
  } catch {
    payoutStatusModule = null;
  }
  return payoutStatusModule;
};

// Settlement status → the bank-transfer and eligibility axes (B12's status model). Used only
// if utils/payoutStatus.js (the shared mapping) isn't there.
const FALLBACK_TRANSFER = {
  draft: 'not_scheduled',
  approved: 'scheduled',
  processing: 'processing',
  paid: 'paid',
  failed: 'failed',
  on_hold: 'not_scheduled',
  carried_forward: 'not_scheduled',
};

const axesOf = async (settlement) => {
  const mod = await loadPayoutStatus();
  if (typeof mod?.transferOf === 'function') {
    const transfer = mod.transferOf(settlement);
    const eligibility = typeof mod.eligibilityOf === 'function'
      ? mod.eligibilityOf(settlement)
      : settlement.status === 'on_hold' ? 'on_hold' : 'eligible';
    return {
      transferStatus: typeof transfer === 'string' ? transfer : transfer?.status ?? null,
      eligibility: typeof eligibility === 'string' ? eligibility : eligibility?.status ?? null,
    };
  }
  return {
    transferStatus: FALLBACK_TRANSFER[settlement.status] ?? null,
    eligibility: settlement.status === 'on_hold' ? 'on_hold' : 'eligible',
  };
};

const shortCode = (id) => (id ? String(id).slice(-6).toUpperCase() : null);

const settlementSummary = async (settlement, restaurantLast4) => {
  const { transferStatus, eligibility } = await axesOf(settlement);
  return {
    kind: 'payout',
    settlementId: settlement._id,
    period: { start: settlement.periodStart, end: settlement.periodEnd },
    amountPaise: settlement.totals?.netPayable ?? 0,
    transferStatus,
    eligibility,
    scheduledFor: settlement.payout?.scheduledFor ?? null,
    paidAt: settlement.payout?.paidAt ?? null,
    last4: settlement.payout?.beneficiary?.accountNumberLast4 ?? restaurantLast4 ?? null,
    bankReference: settlement.status === 'paid' ? settlement.payout?.utr ?? null : null,
  };
};

const SETTLEMENT_FIELDS = 'restaurantId periodStart periodEnd status totals.netPayable payout';

/**
 * The record a payment issue is about, as the ticket screens show it: a payout (statement)
 * or an order / bill (with the transfer status of the statement it landed in, if any). Read
 * only. `null` for a general ticket or a link that no longer resolves.
 */
export const linkedRecordFor = async (ticket) => {
  if (!ticket.settlementId && !ticket.orderId && !ticket.billId) return null;
  const restaurant = ticket.restaurantId
    ? await Restaurant.findById(ticket.restaurantId).select('name payoutAccount.accountNumberLast4').lean()
    : null;
  const last4 = restaurant?.payoutAccount?.accountNumberLast4 ?? null;

  if (ticket.settlementId) {
    const s = await RestaurantSettlement.findById(ticket.settlementId).select(SETTLEMENT_FIELDS).lean();
    return s ? settlementSummary(s, last4) : null;
  }

  const ofStatement = async (filter) => {
    const entry = await RestaurantLedgerEntry.findOne({ ...filter, settlementId: { $ne: null } })
      .select('settlementId')
      .lean();
    if (!entry) return null;
    const s = await RestaurantSettlement.findById(entry.settlementId).select(SETTLEMENT_FIELDS).lean();
    return s ? settlementSummary(s, last4) : null;
  };

  if (ticket.orderId) {
    const o = await Order.findById(ticket.orderId).select('restaurantId type status paymentStatus grandTotal charges.grandTotal createdAt').lean();
    if (!o) return null;
    const statement = await ofStatement({ orderId: o._id });
    return {
      kind: 'order',
      orderId: o._id,
      displayNo: shortCode(o._id),
      orderType: o.type,
      date: o.createdAt,
      amountPaise: o.charges?.grandTotal ?? toPaise(o.grandTotal ?? 0),
      orderStatus: o.status,
      paymentStatus: o.paymentStatus,
      transferStatus: statement?.transferStatus ?? null,
      statement,
    };
  }

  const b = await Bill.findById(ticket.billId).select('restaurantId billNumber status grandTotal charges.grandTotal createdAt paidAt').lean();
  if (!b) return null;
  const statement = await ofStatement({ billId: b._id });
  return {
    kind: 'bill',
    billId: b._id,
    displayNo: b.billNumber ?? shortCode(b._id),
    date: b.paidAt ?? b.createdAt,
    amountPaise: b.charges?.grandTotal ?? toPaise(b.grandTotal ?? 0),
    billStatus: b.status,
    transferStatus: statement?.transferStatus ?? null,
    statement,
  };
};

/** The payment issues linked to one payout — for the payout detail's linked-ticket banner. */
export const linkedTicketsForSettlement = async (settlementId) => {
  if (!mongoose.isValidObjectId(settlementId)) return [];
  const rows = await SupportTicket.find({ kind: 'payment', settlementId })
    .select('ticketNumber issueType status createdAt resolvedAt')
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((t) => ({
    _id: t._id,
    ticketNumber: t.ticketNumber,
    issueType: t.issueType,
    status: normaliseStatus(t.status),
    createdAt: t.createdAt,
    resolvedAt: t.resolvedAt ?? null,
  }));
};

// ── Payment issues: create ────────────────────────────────────────────────────

const ISSUE_SUBJECTS = {
  payout_not_received: 'Payout not received',
  wrong_deduction: 'Wrong deduction',
  missing_order: 'Missing order',
};

/**
 * A restaurant reports a payment issue. Links must belong to the restaurant — anything else
 * is a 404 (never a hint that the other restaurant's record exists).
 */
export const createPaymentIssue = async ({
  restaurantId,
  ownerId,
  issueType,
  description,
  contactEmail,
  contactPhone,
  settlementId,
  orderId,
  billId,
  file,
}) => {
  const owned = async (Model, id, label) => {
    if (!id) return null;
    if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${label}`);
    const doc = await Model.exists({ _id: id, restaurantId });
    if (!doc) throw new ApiError(404, 'NOT_FOUND', `${label[0].toUpperCase()}${label.slice(1)} not found`);
    return id;
  };
  const links = {
    settlementId: await owned(RestaurantSettlement, settlementId, 'payout'),
    orderId: await owned(Order, orderId, 'order'),
    billId: await owned(Bill, billId, 'bill'),
  };
  if (!links.settlementId && !links.orderId && !links.billId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Say which payout, order or bill this is about');
  }

  const attachment = file ? await storeAttachment(file, { restaurantId, uploadedByType: 'user' }) : null;
  const { text, redacted } = redactSensitive(description);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await SupportTicket.create({
        kind: 'payment',
        raisedByType: 'owner',
        raisedBy: ownerId,
        restaurantId,
        ...links,
        ticketNumber: await nextTicketNumber(),
        issueType,
        category: 'payout',
        subject: ISSUE_SUBJECTS[issueType],
        description: text,
        descriptionRedacted: redacted,
        contactEmail,
        contactPhone: contactPhone || null,
        attachments: attachment ? [attachment] : [],
        priority: issueType === 'payout_not_received' ? 'high' : 'medium',
      });
    } catch (err) {
      // A day's counter racing a hand-made number (never in practice) — draw the next one.
      if (err?.code !== 11000 || !String(err?.message).includes('ticketNumber')) throw err;
    }
  }
  throw new ApiError(409, 'CONCURRENT_UPDATE', 'Please try again');
};

// ── Views ─────────────────────────────────────────────────────────────────────

const messageView = (m, { forOwner }) => ({
  _id: m._id,
  from: m.senderType === 'admin' ? 'support' : 'restaurant',
  ...(forOwner ? {} : { senderType: m.senderType, sender: m.sender }),
  text: m.text,
  sentAt: m.sentAt,
  requestsInformation: Boolean(m.requestsInformation),
  redacted: Boolean(m.redacted),
  attachments: (m.attachments ?? []).map(attachmentView),
});

const progressOf = (t) => ({
  submittedAt: t.createdAt,
  reviewedAt: t.reviewedAt ?? null,
  firstResponseAt: t.firstResponseAt ?? null,
  resolvedAt: normaliseStatus(t.status) === 'resolved' ? t.resolvedAt ?? null : null,
});

/** Owner view of a payment issue. `full` adds messages and the report's attachments. */
export const ownerTicketView = async (t, { full = false, linkedRecord } = {}) => ({
  _id: t._id,
  ticketNumber: t.ticketNumber,
  issueType: t.issueType,
  subject: t.subject,
  status: normaliseStatus(t.status),
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  progress: progressOf(t),
  // The latest unanswered request for information, if any — the owner panel highlights it.
  awaitingInformation:
    normaliseStatus(t.status) === 'awaiting_restaurant'
      ? [...(t.messages ?? [])].reverse().find((m) => m.requestsInformation)?.text ?? null
      : null,
  linkedRecord: linkedRecord !== undefined ? linkedRecord : await linkedRecordFor(t),
  contact: { email: t.contactEmail ?? null, phone: t.contactPhone ? maskPhone(t.contactPhone) : null },
  ...(full
    ? {
        description: t.description,
        descriptionRedacted: Boolean(t.descriptionRedacted),
        attachments: (t.attachments ?? []).map(attachmentView),
        messages: (t.messages ?? []).map((m) => messageView(m, { forOwner: true })),
        resolutionNote: t.resolutionNote ?? null,
      }
    : { messageCount: (t.messages ?? []).length }),
});

/**
 * Admin view. Lists mask the contact phone; the detail (`full`) shows it so support can call.
 * Attachments never carry the storage URL.
 */
// Who raised the ticket and the order it is about, for the admin detail view only (`full`):
// the ticket stores bare ids, so support could see neither who to call back nor what was
// ordered — "one butter naan was missing" with no order or customer attached.
const raiserOf = async (t) => {
  if (t.raisedByType === 'customer') {
    const u = await User.findById(t.raisedBy).select('name phone email').lean();
    return u ? { name: u.name || null, phone: u.phone ?? null, email: u.email ?? null } : null;
  }
  if (t.raisedByType === 'delivery_partner') {
    const d = await DeliveryPartner.findById(t.raisedBy).select('fullName phone').lean();
    return d ? { name: d.fullName ?? null, phone: d.phone ?? null, email: null } : null;
  }
  if (t.raisedByType === 'owner') {
    const u = await User.findById(t.raisedBy).select('name phone email').lean();
    return u ? { name: u.name || null, phone: u.phone ?? null, email: u.email ?? null } : null;
  }
  return null;
};
const orderSummaryOf = async (orderId) => {
  if (!orderId) return null;
  const o = await Order.findById(orderId)
    .select('restaurantId type status paymentStatus refundStatus grandTotal items createdAt deliveredAt')
    .lean();
  if (!o) return null;
  const restaurant = await Restaurant.findById(o.restaurantId).select('name').lean();
  return {
    _id: o._id,
    ref: String(o._id).slice(-6).toUpperCase(),
    restaurant: restaurant ? { _id: restaurant._id, name: restaurant.name } : null,
    type: o.type,
    status: o.status,
    paymentStatus: o.paymentStatus,
    refundStatus: o.refundStatus,
    grandTotal: o.grandTotal,
    items: (o.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity })),
    createdAt: o.createdAt,
    deliveredAt: o.deliveredAt ?? null,
  };
};

export const adminTicketView = async (t, { full = false } = {}) => {
  const [raisedByUser, order] = full ? await Promise.all([raiserOf(t), orderSummaryOf(t.orderId)]) : [undefined, undefined];
  const base = {
    ...t,
    ...(full ? { raisedByUser, order } : {}),
    status: normaliseStatus(t.status),
    contactPhone: t.contactPhone ? (full ? t.contactPhone : maskPhone(t.contactPhone)) : null,
    attachments: (t.attachments ?? []).map(attachmentView),
    messages: (t.messages ?? []).map((m) => messageView(m, { forOwner: false })),
  };
  if (t.kind !== 'payment') return base;
  return { ...base, progress: progressOf(t), linkedRecord: await linkedRecordFor(t) };
};

/** Customer / rider view: the shape their apps already read, old status vocabulary. */
export const legacyTicketView = (t) => ({
  ...t,
  status: legacyStatus(normaliseStatus(t.status) ?? t.status),
  attachments: undefined,
  messages: (t.messages ?? []).map((m) => ({
    senderType: m.senderType,
    sender: m.sender,
    text: m.text,
    sentAt: m.sentAt,
  })),
});
