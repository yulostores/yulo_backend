import { z } from 'zod';
import * as requestService from '../services/request.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const createRequestSchema = z.object({
  type: z.enum(requestService.REQUEST_TYPES),
  tableId: z.string().min(1),
  note: z.string().max(280).optional(),
});

// POST /api/restaurants/:id/requests — public (optionalAuthenticate + loadPublicRestaurant):
// a guest raises an assistance request from the table they scanned. No login required.
export const create = asyncHandler(async (req, res) => {
  const result = createRequestSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request data', result.error.flatten());
  }

  const request = await requestService.createRequest({
    restaurantId: req.publicRestaurant._id,
    tableId: result.data.tableId,
    type: result.data.type,
    note: result.data.note,
    userId: req.user?._id,
  });

  sendSuccess(res, 201, 'Request raised', { request });
});

// GET /api/restaurants/:id/requests?tableId= — the guest's own requests for the table
// they're at (there's no per-guest account requirement, so "mine" means "this table's").
export const listMine = asyncHandler(async (req, res) => {
  const requests = await requestService.listForTable(req.publicRestaurant._id, req.query.tableId);
  sendSuccess(res, 200, 'Requests', { requests });
});
