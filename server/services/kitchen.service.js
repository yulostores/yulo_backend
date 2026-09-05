import Order from '../models/Order.js';
import { ApiError } from '../utils/ApiError.js';
import { notifyService } from './notify.service.js';
import { createOrderBill } from './billing.service.js';
import { autoAssign } from './deliveryAssignment.service.js';
import { enrichOrders } from './orderView.service.js';

// 'served' is the dine-in leg: the kitchen takes a ticket to 'ready', the waiter carries
// it to the table and marks it served. 'preparing' -> 'served' is allowed too, for the
// common case of a restaurant that isn't running the chef KDS at all and whose waiter is
// the only one moving the ticket. Delivery/takeaway keeps its original path untouched.
const VALID_TRANSITIONS = {
  placed:    ['confirmed', 'preparing', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'served', 'cancelled'],
  ready:     ['served', 'out_for_delivery', 'delivered', 'cancelled'],
  served:    ['delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
};

// Enriched like every other order read (services/orderView.service.js) so a kitchen
// ticket can name its table rather than making the chef decode a session id.
export const getQueue = async (restaurantId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  // placed = new order; confirmed = accepted but chef hasn't started
  const orders = await Order.find({
    restaurantId,
    status: { $in: ['placed', 'confirmed'] },
    createdAt: { $gte: startOfToday },
  })
    .sort({ createdAt: 1 })
    .lean();
  return enrichOrders(orders);
};

export const getBoard = async (restaurantId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [active, completed] = await Promise.all([
    Order.find({
      restaurantId,
      status: { $in: ['preparing', 'ready'] },
    }).sort({ createdAt: 1 }).lean(),
    Order.find({
      restaurantId,
      status: { $in: ['served', 'delivered', 'out_for_delivery'] },
      updatedAt: { $gte: today },
    }).sort({ updatedAt: -1 }).limit(20).lean(),
  ]);

  const [enrichedActive, enrichedCompleted] = await Promise.all([
    enrichOrders(active),
    enrichOrders(completed),
  ]);

  return {
    preparing: enrichedActive.filter((o) => o.status === 'preparing'),
    ready:     enrichedActive.filter((o) => o.status === 'ready'),
    completed: enrichedCompleted,
  };
};

// `actor` identifies who drove the transition ({ staffId, staffName, role }) — recorded on
// the order's statusHistory so the owner's per-order detail can say "marked served by
// Ravi at 12:14pm" rather than just showing a bare status. Optional: internal/system
// callers can omit it and the entry is attributed to 'system'.
export const updateOrderStatus = async ({ orderId, currentStatus, newStatus, staffId, actor }) => {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed?.includes(newStatus)) {
    throw new ApiError(
      400,
      'INVALID_TRANSITION',
      `Cannot transition from '${currentStatus}' to '${newStatus}'`
    );
  }

  const now = new Date();
  const historyEntry = {
    status: newStatus,
    at: now,
    byStaffId: actor?.staffId ?? staffId ?? null,
    byStaffName: actor?.staffName ?? null,
    byRole: actor?.role ?? 'system',
  };

  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: currentStatus },
    {
      $set: { status: newStatus, ...(newStatus === 'served' ? { servedAt: now } : {}) },
      $push: { statusHistory: historyEntry },
    },
    { new: true }
  );

  if (!order) {
    throw new ApiError(
      409,
      'CONCURRENT_UPDATE',
      'Status was already changed by another request — please refresh'
    );
  }

  if (newStatus === 'confirmed' && order.type === 'delivery') {
    await autoAssign(order);
  }

  if (newStatus === 'delivered' && order.type !== 'dine_in') {
    order.deliveredAt = new Date();
    // 'pending_cod' (checkout-flow COD orders) and plain 'pending' from the cash-ish
    // paths (dine-in, the raw-items POST /api/orders) both mean "cash to be collected" —
    // settled on delivery. But 'pending' ALSO means "online order awaiting Razorpay
    // verification/webhook" (services/order.service.js's createOrderFromCart) — an
    // unpaid online order must never be silently treated as paid just because it was
    // fulfilled. paymentMethod is what disambiguates the two 'pending' meanings.
    if (
      order.paymentStatus === 'pending_cod' ||
      (order.paymentStatus === 'pending' && order.paymentMethod !== 'online')
    ) {
      order.paymentStatus = 'paid';
    }
    if (order.type === 'delivery' && order.deliveryAssignment?.status !== 'failed') {
      order.deliveryAssignment.status = 'delivered';
    }
    await order.save();
    await createOrderBill(order);
  }

  notifyService.orderStatusUpdated(order);
  return order;
};
