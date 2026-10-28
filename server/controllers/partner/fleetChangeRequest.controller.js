import { z } from 'zod';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import FleetChangeRequest from '../../models/FleetChangeRequest.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Matches FleetChangeRequest.jsx's fixed reason list exactly — validated server-side rather than
// trusting free text for the reason code, same convention as order-reject's SKIP_REASONS. Unlike
// SKIP_REASONS, there's no "Other" option here and notes is always optional (the screen's Input
// placeholder is "Additional notes (optional)…", no conditional requirement).
// The rider app shows the ones that fit the direction: leaving the veg fleet, or joining it (the
// last two — the list used to have only leaving reasons, offered to standard riders too).
const FLEET_CHANGE_REASONS = [
  'Not enough orders on veg fleet',
  'Moving to a different zone',
  'Equipment issue (bag problem)',
  'Personal reason',
  'I want to deliver veg-only orders',
  'I have a certified veg bag',
];

// The one real figure this flow gives — both FleetChangeRequest.jsx ("Ops responds within 72
// hours") and RequestSubmitted.jsx ("...within 72 hours") state it explicitly; not fabricated.
const EXPECTED_RESPONSE_HOURS = 72;

const createSchema = z.object({
  requestedFleetType: z.enum(['veg', 'standard']),
  reason: z.enum(FLEET_CHANGE_REASONS),
  notes: z.string().optional(),
});

export const createFleetChangeRequest = asyncHandler(async (req, res) => {
  const result = createSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid fleet change request', result.error.flatten());
  }
  const { requestedFleetType, reason, notes } = result.data;

  const partner = await DeliveryPartner.findById(req.partner._id).select('fleetType').lean();
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  if (requestedFleetType === partner.fleetType) {
    throw new ApiError(400, 'VALIDATION_ERROR', `You are already on the ${partner.fleetType} fleet`);
  }

  const existingPending = await FleetChangeRequest.findOne({ partnerId: req.partner._id, status: 'pending' });
  if (existingPending) {
    throw new ApiError(409, 'ALREADY_PENDING', 'You already have a pending fleet change request');
  }

  const request = await FleetChangeRequest.create({
    partnerId: req.partner._id,
    currentFleetType: partner.fleetType,
    requestedFleetType,
    reason,
    notes,
  });

  sendSuccess(res, 201, 'Fleet change request submitted', { request, expectedResponseHours: EXPECTED_RESPONSE_HOURS });
});

// Paginated history rather than "just the pending one" — the most recent entry (first page,
// first row) IS the current pending request when one exists, and this doubles as the request
// history a partner would want to see, consistent with the pagination convention used everywhere
// else in this codebase (deposits, payouts, etc).
export const getFleetChangeRequests = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const [rows, total] = await Promise.all([
    FleetChangeRequest.find({ partnerId: req.partner._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    FleetChangeRequest.countDocuments({ partnerId: req.partner._id }),
  ]);

  sendSuccess(res, 200, 'Fleet change requests', {
    rows,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    expectedResponseHours: EXPECTED_RESPONSE_HOURS,
  });
});
