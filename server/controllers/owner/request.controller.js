import { z } from 'zod';
import * as requestService from '../../services/request.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const statusSchema = z.object({ status: z.enum(['acknowledged', 'resolved']) });

// GET /api/owner/:restaurantId/requests?status= — same board the manager portal reads
// (it runs on the owner session, see App.jsx's manager routes comment).
export const list = asyncHandler(async (req, res) => {
  const requests = await requestService.listForRestaurant(req.restaurant._id, {
    status: req.query.status,
  });
  sendSuccess(res, 200, 'Requests', { requests });
});

// PATCH /api/owner/:restaurantId/requests/:id { status }
export const updateStatus = asyncHandler(async (req, res) => {
  const result = statusSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', result.error.flatten());
  }

  // No staff record backs an owner/manager session, so resolvedBy stays null here —
  // resolvedAt still records that (and when) it was closed out.
  const request = await requestService.updateStatus({
    restaurantId: req.restaurant._id,
    requestId: req.params.id,
    status: result.data.status,
  });

  sendSuccess(res, 200, 'Request updated', { request });
});
