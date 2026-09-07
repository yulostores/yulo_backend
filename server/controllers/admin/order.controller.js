import { z } from 'zod';
import Order from '../../models/Order.js';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import { notifyService } from '../../services/notify.service.js';

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
