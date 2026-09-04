import { z } from 'zod';
import Table from '../models/Table.js';
import * as guestOrderService from '../services/guestOrder.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Public, table-scoped guest ordering — the QR self-order flow (yulo_menu). Mounted
// alongside controllers/request.controller.js's guest-assistance routes: optionalAuthenticate
// + loadPublicRestaurant, no JWT required.

const orderItemSchema = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().min(1),
  note: z.string().optional(),
});

const placeOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  specialInstructions: z.string().optional(),
  guestPhone: z.string().min(6).max(20).optional(),
});

// GET /api/restaurants/:id/tables/:tableId — just enough for the landing screen
// ("Table 5"); never exposes qrCode.
export const getTable = asyncHandler(async (req, res) => {
  const table = await Table.findOne({
    _id: req.params.tableId,
    restaurantId: req.publicRestaurant._id,
    isActive: true,
  })
    .select('identifier capacity')
    .lean();
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');

  sendSuccess(res, 200, 'Table', { table });
});

// GET /api/restaurants/:id/tables/:tableId/session — the guest's current visit, if any
// order has been placed yet this session (polled by the status screen).
export const getSession = asyncHandler(async (req, res) => {
  const session = await guestOrderService.getGuestSession({
    restaurantId: req.publicRestaurant._id,
    tableId: req.params.tableId,
  });

  sendSuccess(res, 200, 'Session', { session: session || null });
});

// POST /api/restaurants/:id/tables/:tableId/orders — place a dine-in order with no login.
export const placeOrder = asyncHandler(async (req, res) => {
  const result = placeOrderSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order data', result.error.flatten());
  }

  const idempotencyKey = req.headers['idempotency-key'] || null;

  const { order, tableSessionId } = await guestOrderService.placeGuestOrder({
    restaurantId: req.publicRestaurant._id,
    tableId: req.params.tableId,
    ...result.data,
    idempotencyKey,
  });

  if (order.duplicate) {
    return sendSuccess(res, 200, 'Duplicate — existing order returned', { order: { orderId: order.orderId } });
  }

  sendSuccess(res, 201, 'Order placed', { order, tableSessionId });
});
