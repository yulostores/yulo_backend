import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import * as refundService from '../../services/refund.service.js';

const listSchema = z.object({
  status: z.enum(['pending', 'processing', 'processed', 'failed']).optional(),
  // Rows carry source order | bill | stray_payment; 'stray' is accepted as a short form.
  source: z.enum(['order', 'bill', 'stray_payment', 'stray']).transform((v) => (v === 'stray' ? 'stray_payment' : v)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/admin/finance/refunds?status=&source=&page=&limit= — every refund owed, under way, done or
// failed: orders, dine-in bills and stray payments (paid twice, paid after the bill was settled
// at the counter, …). Each row has `source`. `failed` ones need a retry; `pending` ones are owed
// and not yet sent.
export const listRefunds = asyncHandler(async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  sendSuccess(res, 200, 'Refunds', await refundService.listRefunds(parsed.data));
});

// POST /api/admin/finance/refunds/:orderId/retry — sends a pending, failed or stuck refund to
// Razorpay (again). The id may be an order's, a bill's or a stray payment's (the row's _id).
export const retryRefund = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.orderId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid refund id');
  const { source, doc } = await refundService.retryRefund(req.params.orderId, req.user._id);
  await logActivity({
    adminId: req.user._id,
    action: 'refund.retry',
    // AdminActivityLog has no bill/payment target type: those are logged against the order
    // they relate to when there is one, else the restaurant.
    targetType: source === 'order' || doc.orderId ? 'order' : 'restaurant',
    targetId: source === 'order' ? doc._id : doc.orderId ?? doc.restaurantId,
    metadata: { source, id: doc._id, refundStatus: doc.refund?.status, failureReason: doc.refund?.failureReason ?? null },
  });
  sendSuccess(res, 200, 'Refund retried', { source, refund: doc.refund, refundStatus: doc.refundStatus ?? null });
});
