import mongoose from 'mongoose';
import { z } from 'zod';
import SupportTicket, { PAYMENT_ISSUE_TYPES } from '../../models/SupportTicket.js';
import * as supportTicketService from '../../services/supportTicket.service.js';
import { logActivity } from '../../services/activityLog.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Support & Tickets (every raiser's tickets) and, with kind=payment, the Payment issues queue
// (super admin I1–I3). Statuses are open / in_review / awaiting_restaurant / resolved; the
// pre-B12 in_progress / closed are still accepted on input (the current portal sends them).

const assertId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid ticket id');
};

const listQuery = z.object({
  status: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  category: z.string().max(40).optional(),
  kind: z.enum(['general', 'payment']).optional(),
  issueType: z.enum(PAYMENT_ISSUE_TYPES).optional(),
  restaurantId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const list = asyncHandler(async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid filters', parsed.error.flatten());
  const { status, priority, category, kind, issueType, restaurantId, page, limit } = parsed.data;

  const filter = {};
  if (status) {
    const s = supportTicketService.normaliseStatus(status);
    if (!s) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown status');
    // Matches documents not yet migrated too (in_progress → in_review, closed → resolved).
    filter.status = { $in: [s, ...(s === 'in_review' ? ['in_progress'] : s === 'resolved' ? ['closed'] : [])] };
  }
  if (priority) filter.priority = priority;
  if (category) filter.category = category;
  if (kind === 'payment') filter.kind = 'payment';
  else if (kind === 'general') filter.kind = { $ne: 'payment' };
  if (issueType) filter.issueType = issueType;
  if (restaurantId) filter.restaurantId = new mongoose.Types.ObjectId(restaurantId);

  const countFilter = { ...filter };
  delete countFilter.status;

  const [tickets, total, counts] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('assignedTo', 'name email')
      .populate('restaurantId', 'name')
      .lean(),
    SupportTicket.countDocuments(filter),
    supportTicketService.statusCounts(countFilter),
  ]);

  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Tickets', {
    tickets: await Promise.all(tickets.map((t) => supportTicketService.adminTicketView(t))),
    total,
    page,
    pages: Math.ceil(total / limit),
    counts,
  });
});

// GET /api/admin/tickets/counts?kind=payment — the per-status tab counts.
export const counts = asyncHandler(async (req, res) => {
  const kind = req.query.kind;
  const filter = kind === 'payment' ? { kind: 'payment' } : kind === 'general' ? { kind: { $ne: 'payment' } } : {};
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Ticket counts', { counts: await supportTicketService.statusCounts(filter) });
});

const loadTicket = async (id) => {
  assertId(id);
  const ticket = await SupportTicket.findById(id);
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  return ticket;
};

const detailOf = async (id) => {
  const ticket = await SupportTicket.findById(id)
    .populate('assignedTo', 'name email')
    .populate('restaurantId', 'name')
    .lean();
  return supportTicketService.adminTicketView(ticket, { full: true });
};

export const getOne = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const exists = await SupportTicket.exists({ _id: req.params.id });
  if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Ticket', { ticket: await detailOf(req.params.id) });
});

const updateSchema = z.object({
  status: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assignedTo: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  resolutionNote: z.string().trim().max(1000).optional(),
});

// PATCH /api/admin/tickets/:id — Mark in review / Resolve ticket / reopen, priority, assignee.
// Never touches the linked payout (a ticket doesn't change a payment status).
export const update = asyncHandler(async (req, res) => {
  const result = updateSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid ticket update data', result.error.flatten());
  }
  const { status, priority, assignedTo, resolutionNote } = result.data;
  const ticket = await loadTicket(req.params.id);
  const before = supportTicketService.normaliseStatus(ticket.status);

  if (priority !== undefined) ticket.priority = priority;
  if (assignedTo !== undefined) ticket.assignedTo = assignedTo;
  if (status !== undefined) {
    await supportTicketService.setTicketStatus(ticket, status, { resolutionNote });
  } else {
    await ticket.save();
  }

  await logActivity({
    adminId: req.user._id,
    action: 'ticket.update',
    targetType: 'ticket',
    targetId: ticket._id,
    metadata: {
      ticketNumber: ticket.ticketNumber ?? null,
      ...(status !== undefined ? { from: before, to: supportTicketService.normaliseStatus(ticket.status) } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(assignedTo !== undefined ? { assignedTo } : {}),
    },
  });
  sendSuccess(res, 200, 'Ticket updated', { ticket: await detailOf(ticket._id) });
});

const messageSchema = z.object({ text: z.string().trim().min(1).max(4000) });

const replyWith = ({ requestsInformation }) =>
  asyncHandler(async (req, res) => {
    const result = messageSchema.safeParse(req.body ?? {});
    if (!result.success) {
      throw new ApiError(
        400,
        requestsInformation ? 'MESSAGE_REQUIRED' : 'VALIDATION_ERROR',
        requestsInformation ? 'Say what information the restaurant should send' : 'Invalid message data',
        result.error.flatten()
      );
    }
    const ticket = await loadTicket(req.params.id);
    const attachment = req.file
      ? await supportTicketService.storeAttachment(req.file, { restaurantId: ticket.restaurantId, uploadedByType: 'admin' })
      : null;

    await supportTicketService.addTicketMessage(ticket, {
      senderType: 'admin',
      sender: req.user._id,
      text: result.data.text,
      attachments: attachment ? [attachment] : [],
      requestsInformation,
    });

    await logActivity({
      adminId: req.user._id,
      action: requestsInformation ? 'ticket.request_information' : 'ticket.reply',
      targetType: 'ticket',
      targetId: ticket._id,
      metadata: { ticketNumber: ticket.ticketNumber ?? null, status: ticket.status, attachment: Boolean(attachment) },
    });
    sendSuccess(res, 200, requestsInformation ? 'Information requested' : 'Message added', {
      ticket: await detailOf(ticket._id),
    });
  });

// POST /api/admin/tickets/:id/messages — reply (JSON, or multipart with `attachment`).
export const addMessage = replyWith({ requestsInformation: false });
// POST /api/admin/tickets/:id/request-information — "Ask restaurant for information".
export const requestInformation = replyWith({ requestsInformation: true });

// GET /api/admin/tickets/:id/attachments/:attachmentId — streamed, never a storage URL.
export const getAttachment = asyncHandler(async (req, res) => {
  const ticket = await loadTicket(req.params.id);
  res.set('Cache-Control', 'no-store');
  await supportTicketService.streamAttachment(ticket.toObject(), req.params.attachmentId, res);
});
