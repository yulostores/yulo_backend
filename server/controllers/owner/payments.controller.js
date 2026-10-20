import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as ownerPayments from '../../services/ownerPayments.service.js';

// The restaurant portal's Payments & Payouts screens (Figma owner frames, F5) — read-only, the
// owner's own restaurant only. Every response is owner-safe (services/ownerPayments.service.js).

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be an id');
const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

const parse = (schema, input) => {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};

const overviewSchema = z.object({
  statementId: objectId.optional(),
  weekStart: z.coerce.date().optional(),
  status: z.enum(['pending', 'eligible', 'on_hold', 'settled', 'refunded']).optional(),
  ...paging,
});

const historySchema = z.object({
  transferStatus: z.enum(['not_scheduled', 'scheduled', 'processing', 'paid', 'failed', 'carried_forward']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...paging,
});

// GET /api/owner/:restaurantId/payments/overview
export const overview = asyncHandler(async (req, res) => {
  const q = parse(overviewSchema, req.query);
  sendSuccess(res, 200, 'Payments overview', await ownerPayments.overview(req.restaurant._id, q));
});

// GET /api/owner/:restaurantId/payments/history
export const history = asyncHandler(async (req, res) => {
  const q = parse(historySchema, req.query);
  sendSuccess(res, 200, 'Payout history', await ownerPayments.history(req.restaurant._id, q));
});

// GET /api/owner/:restaurantId/payments/statements/:statementId
export const statement = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Statement', await ownerPayments.statementDetail(req.restaurant._id, req.params.statementId));
});

// GET /api/owner/:restaurantId/payments/orders/:orderId
export const order = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Order payment detail', await ownerPayments.paymentDetail(req.restaurant._id, 'order', req.params.orderId));
});

// GET /api/owner/:restaurantId/payments/bills/:billId
export const bill = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Bill payment detail', await ownerPayments.paymentDetail(req.restaurant._id, 'bill', req.params.billId));
});

// GET /api/owner/:restaurantId/payments/settings
export const settings = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Bank & payout settings', await ownerPayments.payoutSettings(req.restaurant._id));
});
