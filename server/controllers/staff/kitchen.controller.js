import { z } from 'zod';
import * as kitchenService from '../../services/kitchen.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import Order from '../../models/Order.js';

const updateStatusSchema = z.object({
  newStatus: z.enum([
    'confirmed', 'preparing', 'ready', 'served', 'out_for_delivery', 'delivered', 'cancelled',
  ]),
});

export const getQueue = asyncHandler(async (req, res) => {
  const orders = await kitchenService.getQueue(req.staff.restaurantId);
  sendSuccess(res, 200, 'Kitchen queue', { orders });
});

export const getBoard = asyncHandler(async (req, res) => {
  const board = await kitchenService.getBoard(req.staff.restaurantId);
  sendSuccess(res, 200, 'Kitchen board', board);
});

export const updateStatus = asyncHandler(async (req, res) => {
  const result = updateStatusSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', result.error.flatten());
  }

  // Fetch current status from DB so client doesn't need to track it
  const existing = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.staff.restaurantId,
  }).select('status type');
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  if (result.data.newStatus === 'served' && existing.type !== 'dine_in') {
    throw new ApiError(400, 'INVALID_TRANSITION', "Only dine-in orders can be marked 'served'");
  }

  const order = await kitchenService.updateOrderStatus({
    orderId: req.params.orderId,
    currentStatus: existing.status,
    newStatus: result.data.newStatus,
    staffId: req.staff._id,
    actor: { staffId: req.staff._id, staffName: req.staff.name, role: 'chef' },
  });

  sendSuccess(res, 200, 'Order status updated', { order });
});

export const getOrderDetail = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.staff.restaurantId,
  }).lean();

  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  sendSuccess(res, 200, 'Order detail', { order });
});
