import { z } from 'zod';
import SupportTicket from '../models/SupportTicket.js';
import Order from '../models/Order.js';
import * as supportTicketService from '../services/supportTicket.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const CUSTOMER_CATEGORIES = [
  'order_delayed',
  'wrong_missing_items',
  'veg_fleet_issue',
  'payment_refund',
  'other',
];

// Screen 26 shows fixed category ROWS ("Order is delayed", "Wrong or missing items", ...)
// — there's no free-text subject field in this flow at all. SupportTicket.subject is
// required (shared with the owner/admin/delivery-partner ticket flows, which DO collect
// one), so it's synthesized here from category rather than adding a UI field this screen
// was never designed to have.
const CATEGORY_SUBJECTS = {
  order_delayed: 'Order is delayed',
  wrong_missing_items: 'Wrong or missing items',
  veg_fleet_issue: 'Issue with veg-only fleet delivery',
  payment_refund: 'Payment or refund query',
  other: 'Other',
};

const createTicketSchema = z.object({
  category: z.enum(CUSTOMER_CATEGORIES),
  description: z.string().min(1),
  orderId: z.string().optional(),
});

export const createTicket = asyncHandler(async (req, res) => {
  const result = createTicketSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid support ticket', result.error.flatten());
  }
  const { category, description, orderId } = result.data;

  if (orderId) {
    const ownsOrder = await Order.exists({ _id: orderId, userId: req.user._id });
    if (!ownsOrder) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  }

  const ticket = await SupportTicket.create({
    raisedByType: 'customer',
    raisedBy: req.user._id,
    orderId: orderId ?? null,
    subject: CATEGORY_SUBJECTS[category],
    description,
    category,
  });

  sendSuccess(res, 201, 'Support ticket submitted', { ticket: supportTicketService.legacyTicketView(ticket.toObject()) });
});

// Own tickets only — filtered by raisedBy, unlike the admin list endpoint
// (controllers/admin/ticket.controller.js), which sees every raiser's tickets.
export const listTickets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = { raisedByType: 'customer', raisedBy: req.user._id };
  const skip = (Number(page) - 1) * Number(limit);

  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    SupportTicket.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Support tickets', {
    // The app reads the pre-B12 status vocabulary (open / in_progress / resolved / closed).
    tickets: tickets.map(supportTicketService.legacyTicketView),
    total,
    page: Number(page),
    pages: Math.max(1, Math.ceil(total / Number(limit))),
  });
});

export const getTicket = asyncHandler(async (req, res) => {
  const ticket = await SupportTicket.findOne({
    _id: req.params.id,
    raisedByType: 'customer',
    raisedBy: req.user._id,
  }).lean();
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');
  sendSuccess(res, 200, 'Ticket', { ticket: supportTicketService.legacyTicketView(ticket) });
});

const messageSchema = z.object({ text: z.string().min(1) });

export const addMessage = asyncHandler(async (req, res) => {
  const result = messageSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid message data', result.error.flatten());
  }
  const { text } = result.data;

  const ticket = await SupportTicket.findOne({
    _id: req.params.id,
    raisedByType: 'customer',
    raisedBy: req.user._id,
  });
  if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Ticket not found');

  await supportTicketService.addTicketMessage(ticket, { senderType: 'user', sender: req.user._id, text });

  sendSuccess(res, 200, 'Message added', { ticket: supportTicketService.legacyTicketView(ticket.toObject()) });
});
