import { z } from 'zod';
import * as requestService from '../../services/request.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const statusSchema = z.object({ status: z.enum(['acknowledged', 'resolved']) });

// GET /api/staff/:restaurantId/requests?status=
export const list = asyncHandler(async (req, res) => {
  const requests = await requestService.listForRestaurant(req.staff.restaurantId, {
    status: req.query.status,
  });
  sendSuccess(res, 200, 'Requests', { requests });
});

// PATCH /api/staff/:restaurantId/requests/:id { status }
export const updateStatus = asyncHandler(async (req, res) => {
  const result = statusSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', result.error.flatten());
  }

  const request = await requestService.updateStatus({
    restaurantId: req.staff.restaurantId,
    requestId: req.params.id,
    status: result.data.status,
    staffId: req.staff._id,
  });

  sendSuccess(res, 200, 'Request updated', { request });
});
