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

// guestName/guestPhone are how an anonymous diner says who they are — the QR flow's
// equivalent of the account a signed-in customer already has. Both optional: a guest who
// declines still gets to eat, and the order simply carries no customer name (the table
// number is what the floor works from either way).
//
// Ignored entirely when the request carries a valid token: a signed-in customer IS
// identified, and letting the body override that would put an unverified name and number
// on an order the restaurant would then trust. See the `identity` block in placeOrder.
const placeOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1),
  specialInstructions: z.string().optional(),
  guestName: z.string().trim().min(1).max(60).optional(),
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

  // This route runs under optionalAuthenticate, so the same QR link serves two people: a
  // signed-in customer who happens to be sitting at the table, and a walk-in guest with
  // no account. They are the same order in every respect except who it belongs to, and
  // that difference is settled once, here, rather than being re-guessed downstream.
  //
  // A signed-in customer's order gets their userId — which makes it appear in their own
  // order history, bind to their loyalty, and carry their verified name/phone — and their
  // typed guest fields are discarded. An anonymous one carries what they told us.
  const { guestName, guestPhone, ...orderData } = result.data;
  const identity = req.user?.role === 'customer'
    ? { userId: req.user._id }
    : { guestName, guestPhone };

  const { order, tableSessionId } = await guestOrderService.placeGuestOrder({
    restaurantId: req.publicRestaurant._id,
    tableId: req.params.tableId,
    ...orderData,
    ...identity,
    idempotencyKey,
  });

  if (order.duplicate) {
    return sendSuccess(res, 200, 'Duplicate — existing order returned', { order: { orderId: order.orderId } });
  }

  sendSuccess(res, 201, 'Order placed', { order, tableSessionId });
});
