import mongoose from 'mongoose';
import { z } from 'zod';
import SupportTicket, { PAYMENT_ISSUE_TYPES } from '../../models/SupportTicket.js';
import * as supportTicketService from '../../services/supportTicket.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// A restaurant's payment issues (owner H / F5b): report one about a payout, an order or a bill,
// follow it, add information. Scoped to the restaurant in the URL — authorizeRestaurant has
// already checked it belongs to this owner, and every query below filters on it, so another
// restaurant's ticket is a plain 404.

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

const createSchema = z.object({
  issueType: z.enum(PAYMENT_ISSUE_TYPES),
  description: z.string().trim().min(10, 'Describe the issue (at least 10 characters)').max(4000),
  contactEmail: z.string().trim().email('Enter a valid email').max(200),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s-]{7,20}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('')),
  settlementId: objectId.optional(),
  orderId: objectId.optional(),
  billId: objectId.optional(),
});

// POST /api/owner/:restaurantId/payment-issues — JSON, or multipart with an `attachment` file.
export const create = asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Check the highlighted fields', parsed.error.flatten());
  }
  const ticket = await supportTicketService.createPaymentIssue({
    ...parsed.data,
    restaurantId: req.restaurant._id,
    ownerId: req.user._id,
    file: req.file,
  });
  sendSuccess(res, 201, 'Payment issue submitted', {
    ticket: await supportTicketService.ownerTicketView(ticket.toObject(), { full: true }),
  });
});

const listQuery = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/owner/:restaurantId/payment-issues?status=&page=&limit=
export const list = asyncHandler(async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid filters', parsed.error.flatten());
  const { status, page, limit } = parsed.data;

  const base = { kind: 'payment', restaurantId: req.restaurant._id };
  const filter = { ...base };
  if (status) {
    const s = supportTicketService.normaliseStatus(status);
    if (!s) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown status');
    filter.status = s;
  }
  const [rows, total, counts] = await Promise.all([
    SupportTicket.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SupportTicket.countDocuments(filter),
    supportTicketService.statusCounts(base),
  ]);
  sendSuccess(res, 200, 'Payment issues', {
    tickets: await Promise.all(rows.map((t) => supportTicketService.ownerTicketView(t))),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    counts,
  });
});

const loadOwn = async (req) => {
  if (!mongoose.isValidObjectId(req.params.ticketId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid ticket id');
  }
  const ticket = await SupportTicket.findOne({
    _id: req.params.ticketId,
    kind: 'payment',
    restaurantId: req.restaurant._id,
  });
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Payment issue not found');
  return ticket;
};

// GET /api/owner/:restaurantId/payment-issues/:ticketId
export const detail = asyncHandler(async (req, res) => {
  const ticket = await loadOwn(req);
  sendSuccess(res, 200, 'Payment issue', {
    ticket: await supportTicketService.ownerTicketView(ticket.toObject(), { full: true }),
  });
});

const messageSchema = z.object({ text: z.string().trim().min(1).max(4000) });

// POST /api/owner/:restaurantId/payment-issues/:ticketId/messages — "Add information" (JSON, or
// multipart with an `attachment`). Answers a request for information → back to in review.
export const addMessage = asyncHandler(async (req, res) => {
  const parsed = messageSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Write a message', parsed.error.flatten());
  const ticket = await loadOwn(req);
  const attachment = req.file
    ? await supportTicketService.storeAttachment(req.file, { restaurantId: req.restaurant._id, uploadedByType: 'user' })
    : null;
  await supportTicketService.addTicketMessage(ticket, {
    senderType: 'user',
    sender: req.user._id,
    text: parsed.data.text,
    attachments: attachment ? [attachment] : [],
  });
  sendSuccess(res, 200, 'Information added', {
    ticket: await supportTicketService.ownerTicketView(ticket.toObject(), { full: true }),
  });
});

// GET /api/owner/:restaurantId/payment-issues/:ticketId/attachments/:attachmentId
export const getAttachment = asyncHandler(async (req, res) => {
  const ticket = await loadOwn(req);
  await supportTicketService.streamAttachment(ticket.toObject(), req.params.attachmentId, res);
});
