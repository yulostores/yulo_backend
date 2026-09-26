// The restaurant's approval step for customer orders.
//
// A customer's order (the delivery app's checkout, the raw POST /api/orders, or the table
// QR in yulo_menu) is created 'placed' and stops there: the chef KDS, the waiter portal
// and the rider search all ignore a 'placed' order. The owner portal is the only place it
// shows up, and this file is the only way out of that state:
//
//   accept -> 'confirmed'  (reaches the kitchen and floor; a delivery order starts rider search)
//   reject -> 'cancelled'  (with a reason the customer is shown)
//
// Both go through kitchen.service.js's updateOrderStatus, so the compare-and-swap, the
// status history entry and the socket fan-out are the same as every other transition.
// Waiter-placed orders never pass through here — they are created 'confirmed' (see
// services/order.service.js's createOrder).
//
// Two more exits keep a 'placed' order from waiting forever:
//   the customer cancels it themselves while it is still waiting (cancelByCustomer)
//   nobody answers within ORDER_APPROVAL_TIMEOUT_MINUTES -> cancelled by the system
//     (expireUnansweredOrders, run on socket.js's existing interval)
//
// The rules themselves — who may leave 'placed', and that an online order must be paid
// before it is accepted — live in kitchen.service.js's updateOrderStatus, so every caller
// gets them, not just these.

import Order from '../models/Order.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { updateOrderStatus } from './kitchen.service.js';

// The reasons the owner portal offers as one-tap choices. Free text is accepted too; this
// list is served to the portal so its chips and the backend never disagree.
export const REJECTION_REASONS = [
  'Restaurant is too busy right now',
  'One or more items are out of stock',
  'Restaurant is closing soon',
  'Unable to deliver to this address',
  'Other',
];

// The 'Other' chip is a prompt to type a reason, not a reason: the customer would otherwise
// be told their order was rejected because of "Other".
const OTHER_REASON = 'other';

const OWNER_ACTOR = (user) => ({ staffId: null, staffName: user?.name || 'Restaurant', role: 'owner' });

const DECIDED_MESSAGES = {
  cancelled: 'This order has already been rejected or cancelled',
  default: 'This order has already been accepted',
};

const loadPendingOrder = async (filter) => {
  const order = await Order.findOne(filter).select('status');
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.status !== 'placed') {
    throw new ApiError(
      409,
      'ORDER_ALREADY_DECIDED',
      DECIDED_MESSAGES[order.status] ?? DECIDED_MESSAGES.default
    );
  }
  return order;
};

export const acceptOrder = async ({ restaurantId, orderId, user }) => {
  await loadPendingOrder({ _id: orderId, restaurantId });
  // PAYMENT_PENDING for an unpaid online order is raised by updateOrderStatus, atomically
  // with the status change.
  return updateOrderStatus({
    orderId,
    currentStatus: 'placed',
    newStatus: 'confirmed',
    actor: OWNER_ACTOR(user),
  });
};

export const rejectOrder = async ({ restaurantId, orderId, user, reason }) => {
  if (reason?.trim().toLowerCase() === OTHER_REASON) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Tell the customer why — type a reason instead of "Other"');
  }
  await loadPendingOrder({ _id: orderId, restaurantId });

  return updateOrderStatus({
    orderId,
    currentStatus: 'placed',
    newStatus: 'cancelled',
    actor: OWNER_ACTOR(user),
    reason,
  });
};

// The customer changing their mind while the restaurant hasn't answered yet. Once accepted
// the kitchen may already be cooking, so it is refused from then on.
export const cancelByCustomer = async ({ userId, orderId }) => {
  const order = await Order.findOne({ _id: orderId, userId }).select('status');
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.status !== 'placed') {
    throw new ApiError(
      409,
      'ORDER_NOT_CANCELLABLE',
      order.status === 'cancelled'
        ? 'This order is already cancelled'
        : 'The restaurant has already accepted this order — contact support to cancel it'
    );
  }

  try {
    return await updateOrderStatus({
      orderId,
      currentStatus: 'placed',
      newStatus: 'cancelled',
      actor: { role: 'customer' },
      reason: 'Cancelled by you',
    });
  } catch (err) {
    // Lost the race to the restaurant accepting or rejecting it at the same moment.
    if (err.code === 'ORDER_ALREADY_DECIDED') {
      throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', 'The restaurant has just responded to this order — please refresh');
    }
    throw err;
  }
};

export const APPROVAL_TIMEOUT_REASON = "The restaurant didn't respond in time";

// Cancels every order that has waited longer than ORDER_APPROVAL_TIMEOUT_MINUTES for the
// restaurant. Each goes through updateOrderStatus (compare-and-swap), so an owner accepting
// at the same instant simply wins and the sweep skips it. Never throws.
export const expireUnansweredOrders = async ({ now = new Date() } = {}) => {
  const cutoff = new Date(now.getTime() - env.ORDER_APPROVAL_TIMEOUT_MINUTES * 60 * 1000);
  const stale = await Order.find({ status: 'placed', createdAt: { $lt: cutoff } })
    .select('_id')
    .limit(500)
    .lean();

  let expired = 0;
  for (const { _id } of stale) {
    try {
      await updateOrderStatus({
        orderId: _id,
        currentStatus: 'placed',
        newStatus: 'cancelled',
        actor: { role: 'system' },
        reason: APPROVAL_TIMEOUT_REASON,
      });
      expired += 1;
    } catch (err) {
      if (err.code !== 'ORDER_ALREADY_DECIDED') {
        logger.error({ err, orderId: _id }, 'Failed to expire unanswered order');
      }
    }
  }
  return expired;
};
