import mongoose from 'mongoose';
import { z } from 'zod';
import Order from '../../models/Order.js';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import { notifyService } from '../../services/notify.service.js';
import { ASSIGNABLE_STATUSES, computeRiderEarningsBreakdown } from '../../services/deliveryAssignment.service.js';
import { updateOrderStatus } from '../../services/kitchen.service.js';
import { withoutInternalMoney } from '../../services/ledger.service.js';

const reassignSchema = z.object({
  partnerId: z.string().min(1),
  reason: z.string().optional(),
});

export const reassignDeliveryPartner = asyncHandler(async (req, res) => {
  const result = reassignSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid reassignment data', result.error.flatten());
  }
  const { partnerId, reason } = result.data;

  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.type !== 'delivery') {
    throw new ApiError(400, 'INVALID_ORDER_TYPE', 'Only delivery orders can be reassigned');
  }
  // Automatic assignment's rule (deliveryAssignment.service.js's ASSIGNABLE_STATUSES), plus
  // 'out_for_delivery': a rider breaking down mid-delivery is exactly when an admin steps in.
  // Never for food the restaurant hasn't accepted, has cancelled, or has already delivered.
  if (![...ASSIGNABLE_STATUSES, 'out_for_delivery'].includes(order.status)) {
    throw new ApiError(
      409,
      'ORDER_NOT_ASSIGNABLE',
      order.status === 'placed'
        ? 'The restaurant has not accepted this order yet'
        : `A rider can't be assigned to an order that is ${order.status.replace(/_/g, ' ')}`
    );
  }

  const previousPartnerId = order.deliveryAssignment?.partnerId ?? null;
  const now = new Date();

  order.deliveryAssignment.history.push({
    partnerId: previousPartnerId,
    assignedAt: order.deliveryAssignment.assignedAt,
    assignedBy: order.deliveryAssignment.assignedBy,
    unassignedAt: now,
    reason,
  });
  order.deliveryAssignment.partnerId = partnerId;
  order.deliveryAssignment.status = 'assigned';
  order.deliveryAssignment.assignedAt = now;
  order.deliveryAssignment.assignedBy = 'admin';
  // The new rider's pay, fixed at assignment like an auto-assigned one.
  order.deliveryAssignment.earningsBreakdown = await computeRiderEarningsBreakdown(order);

  await order.save();

  const newPartner = await DeliveryPartner.findById(partnerId).lean();
  notifyService.deliveryAssignmentUpdated(order, newPartner);

  await logActivity({
    adminId: req.user._id,
    action: 'ORDER_DELIVERY_REASSIGNED',
    targetType: 'order',
    targetId: order._id,
    metadata: { from: previousPartnerId, to: partnerId, reason },
  });

  sendSuccess(res, 200, 'Delivery partner reassigned', { order });
});

const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });

// PATCH /api/admin/orders/:id/cancel { reason } — the platform cancelling an order (customer
// complaint, restaurant unreachable, …) at any point before it is delivered or served. Goes
// through the same updateOrderStatus every other cancellation does, so the rider is released
// and an online payment is refunded in full (services/refund.service.js decides who bears
// Razorpay's fee — an admin cancel after acceptance is booked like the restaurant cancelling).
export const cancelOrder = asyncHandler(async (req, res) => {
  const result = cancelSchema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A reason (3–300 characters) is required', result.error.flatten());
  }
  const { reason } = result.data;
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order id');

  const current = await Order.findById(req.params.id).select('status').lean();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (['cancelled', 'delivered'].includes(current.status)) {
    throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', `This order is already ${current.status}`);
  }

  let order;
  try {
    order = await updateOrderStatus({
      orderId: current._id,
      currentStatus: current.status,
      newStatus: 'cancelled',
      actor: { role: 'admin', staffName: req.user.name || 'Yulo support' },
      reason,
    });
  } catch (err) {
    if (['CONCURRENT_UPDATE', 'ORDER_ALREADY_DECIDED', 'INVALID_TRANSITION'].includes(err.code)) {
      throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', 'The order was just updated (or already handed over) — refresh and try again');
    }
    throw err;
  }

  await logActivity({
    adminId: req.user._id,
    action: 'ORDER_CANCELLED',
    targetType: 'order',
    targetId: order._id,
    metadata: {
      reason,
      previousStatus: current.status,
      refundStatus: order.refund?.status ?? null,
    },
  });

  sendSuccess(res, 200, 'Order cancelled', { order: withoutInternalMoney(order) });
});
