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
import { CUSTOMER_CANCELLABLE_STATUSES, PREPARATION_STARTED_STATUSES } from './refund.service.js';

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

// The customer cancelling their own order. Allowed:
//   - while the restaurant hasn't answered, or has accepted but the kitchen hasn't started —
//     a full refund of an online payment (services/refund.service.js);
//   - once the kitchen has started ('preparing'/'ready') — but only with confirmNoRefund:
//     the customer is told they get nothing back, and the restaurant is paid for the food.
// Refused once the food has left the kitchen with a rider, or the order is finished.
export const cancelByCustomer = async ({ userId, orderId, confirmNoRefund = false }) => {
  const order = await Order.findOne({ _id: orderId, userId }).select('status deliveryAssignment.status');
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  const pickedUp = ['picked_up', 'delivered'].includes(order.deliveryAssignment?.status);
  if (!CUSTOMER_CANCELLABLE_STATUSES.has(order.status) || pickedUp) {
    throw new ApiError(
      409,
      'ORDER_NOT_CANCELLABLE',
      order.status === 'cancelled'
        ? 'This order is already cancelled'
        : 'Your order is already on its way — contact support for help'
    );
  }

  if (PREPARATION_STARTED_STATUSES.has(order.status) && !confirmNoRefund) {
    throw new ApiError(
      400,
      'CONFIRMATION_REQUIRED',
      'The restaurant has started preparing your food. If you cancel now you will not get a refund.',
      { refundPercent: 0, status: order.status }
    );
  }

  try {
    return await updateOrderStatus({
      orderId,
      currentStatus: order.status,
      newStatus: 'cancelled',
      actor: { role: 'customer' },
      reason: PREPARATION_STARTED_STATUSES.has(order.status)
        ? 'Cancelled by you after preparation started — no refund'
        : 'Cancelled by you',
    });
  } catch (err) {
    // Lost a race: the restaurant answered, or the kitchen moved the order on, at the same moment.
    if (['ORDER_ALREADY_DECIDED', 'CONCURRENT_UPDATE', 'ORDER_AWAITING_APPROVAL'].includes(err.code)) {
      throw new ApiError(409, 'ORDER_NOT_CANCELLABLE', 'Your order was just updated — please refresh and try again');
    }
    throw err;
  }
};

export const APPROVAL_TIMEOUT_REASON = "The restaurant didn't respond in time";

// Which 'placed' orders have waited too long. The restaurant can only accept an online order
// once it is paid, so that order's clock starts at payment (paidAt) — counting from createdAt
// cancelled orders the restaurant had seen for a minute (a customer who took 14 minutes to pay),
// and charged the restaurant Razorpay's fee on the refund. Unpaid online orders and cash orders
// count from creation; so does a paid order from before paidAt existed.
const timedOut = (cutoff) => ({
  $or: [
    { paymentMethod: { $ne: 'online' }, createdAt: { $lt: cutoff } },
    { paymentMethod: 'online', paidAt: { $lt: cutoff } },
    { paymentMethod: 'online', paidAt: null, createdAt: { $lt: cutoff } },
  ],
});

// Cancels every order that has waited longer than ORDER_APPROVAL_TIMEOUT_MINUTES for the
// restaurant. Each goes through updateOrderStatus (compare-and-swap, re-checking the same
// deadline), so an owner accepting — or a payment landing — at the same instant simply wins and
// the sweep skips it. Never throws.
export const expireUnansweredOrders = async ({ now = new Date() } = {}) => {
  const cutoff = new Date(now.getTime() - env.ORDER_APPROVAL_TIMEOUT_MINUTES * 60 * 1000);
  const stale = await Order.find({ status: 'placed', ...timedOut(cutoff) })
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
        guard: timedOut(cutoff),
      });
      expired += 1;
    } catch (err) {
      if (!['ORDER_ALREADY_DECIDED', 'CONCURRENT_UPDATE'].includes(err.code)) {
        logger.error({ err, orderId: _id }, 'Failed to expire unanswered order');
      }
    }
  }
  return expired;
};

/** When an order still waiting for the restaurant will be auto-cancelled (null once decided). */
export const approvalExpiresAt = (order) => {
  if (order?.status !== 'placed') return null;
  const start = order.paymentMethod === 'online' && order.paidAt ? order.paidAt : order.createdAt;
  return start ? new Date(new Date(start).getTime() + env.ORDER_APPROVAL_TIMEOUT_MINUTES * 60 * 1000) : null;
};
