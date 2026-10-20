import { z } from 'zod';
import SupportTicket from '../../models/SupportTicket.js';
import { legacyTicketView } from '../../services/supportTicket.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// SupportTicket already supports this with zero schema changes: raisedByType's enum already
// includes 'delivery_partner', restaurantId is already optional, and raisedBy is a bare (unref'd)
// ObjectId reused across raiser types rather than a typed ref — exactly the shape needed to store
// a partner's own id here without a dangling/incorrect reference.
const createTicketSchema = z.object({
  subject: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['billing', 'technical', 'account', 'delivery', 'other']).optional(),
});

export const createSupportTicket = asyncHandler(async (req, res) => {
  const result = createTicketSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid support ticket', result.error.flatten());
  }
  const { subject, description, category } = result.data;

  // SupportHelp.jsx's "Call support"/"Chat with us"/"Email us" rows have no realistic backend to
  // wire to anywhere in this codebase (no telephony/chat/email integration exists) and correctly
  // stay no-ops — only "Report an issue" maps to something real: a ticket the admin's existing
  // ticket.controller.js can actually list/manage. Not building phone/chat/email integrations
  // that don't exist elsewhere, per the plan.
  const ticket = await SupportTicket.create({
    raisedByType: 'delivery_partner',
    raisedBy: req.partner._id,
    subject,
    description,
    category: category ?? 'other',
  });

  sendSuccess(res, 201, 'Support ticket submitted', { ticket: legacyTicketView(ticket.toObject()) });
});

export const listSupportTickets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const filter = { raisedByType: 'delivery_partner', raisedBy: req.partner._id };
  const skip = (Number(page) - 1) * Number(limit);

  const [rows, total] = await Promise.all([
    SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    SupportTicket.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Support tickets', {
    // The rider app reads the pre-B12 status vocabulary (open / in_progress / resolved / closed).
    rows: rows.map(legacyTicketView),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});
