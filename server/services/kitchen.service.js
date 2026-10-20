import Order from '../models/Order.js';
import { ApiError } from '../utils/ApiError.js';
import { notifyService } from './notify.service.js';
import { assertRoundCancellable, createOrderBill } from './billing.service.js';
import { autoAssign, countCompletedDelivery, keepWaitingForVegFleet, releaseAssignmentForCancelledOrder } from './deliveryAssignment.service.js';
import { enrichOrders } from './orderView.service.js';
import { onOrderCancelled } from './refund.service.js';
import { onOrderDelivered } from './ledger.service.js';

// 'served' is the dine-in leg: the kitchen takes a ticket to 'ready', the waiter carries
// it to the table and marks it served. 'preparing' -> 'served' is allowed too, for the
// common case of a restaurant that isn't running the chef KDS at all and whose waiter is
// the only one moving the ticket. Delivery/takeaway keeps its original path untouched.
//
// 'placed' has exactly two exits — accepted ('confirmed') or rejected ('cancelled') — and
// only the restaurant's approval step takes either (services/orderApproval.service.js).
// The chef and waiter endpoints refuse to touch a 'placed' order at all (see
// assertNotAwaitingApproval below), so there is no way to cook an order the restaurant
// hasn't accepted.
export const VALID_TRANSITIONS = {
  placed:    ['confirmed', 'cancelled'],
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
  // 'confirmed' only — accepted by the restaurant, chef hasn't started. A 'placed' order is
  // still waiting on the restaurant's approval and is deliberately invisible to the kitchen.
  //
  // "Today" is measured from acceptance as well as placement: an order placed at 23:58 and
  // accepted at 00:02 is today's ticket for the kitchen, not yesterday's.
  const orders = await Order.find({
    restaurantId,
    status: 'confirmed',
    $or: [{ createdAt: { $gte: startOfToday } }, { acceptedAt: { $gte: startOfToday } }],
  })
    .sort({ acceptedAt: 1, createdAt: 1 })
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
//
// `reason` is only read for a cancellation — it is stored as Order.cancellationReason,
// which the customer sees.
const CANCELLED_BY_ROLE = { owner: 'restaurant', chef: 'kitchen', waiter: 'waiter', customer: 'customer', admin: 'admin' };

export const ORDER_AWAITING_APPROVAL = 'ORDER_AWAITING_APPROVAL';

// The chef and waiter endpoints call this before any transition: a 'placed' order belongs
// to the restaurant's approval step, not to the floor or the kitchen.
export const assertNotAwaitingApproval = (order) => {
  if (order?.status === 'placed') {
    throw new ApiError(
      409,
      ORDER_AWAITING_APPROVAL,
      'This order is waiting for the restaurant to accept it'
    );
  }
};

// Who may take an order out of 'placed'. Enforced here, in the one function every status
// change goes through, not only in the controllers — so no current or future caller can
// cook an order the restaurant never accepted:
//   owner    accept or reject (services/orderApproval.service.js)
//   customer cancel their own order while it is still waiting
//   system   the approval-timeout sweep (expireUnansweredOrders)
//   admin    cancelling from the admin console (controllers/admin/order.controller.js)
const PLACED_EXIT_ROLES = {
  confirmed: ['owner'],
  cancelled: ['owner', 'customer', 'system', 'admin'],
};

// A cancellation never overtakes a delivery: once the rider has handed the food over, the order
// can't be cancelled (and refunded) underneath them — the rider's deliver endpoint claims the
// assignment atomically, so exactly one of the two wins. A customer can't cancel once the
// rider has collected the food either.
const CANCEL_BLOCKING_ASSIGNMENT = {
  customer: ['picked_up', 'delivered'],
  default: ['delivered'],
};

// An online order may only be accepted once it is paid — checked inside the same atomic
// update as the status change, so a payment that fails in between can't slip through.
const PAID_OR_OFFLINE = { $or: [{ paymentMethod: { $ne: 'online' } }, { paymentStatus: 'paid' }] };

// `guard` (optional) is an extra condition for the compare-and-swap — the approval sweep uses it
// so a payment landing between its read and its write keeps the order alive.
export const updateOrderStatus = async ({ orderId, currentStatus, newStatus, staffId, actor, reason, guard = null }) => {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed?.includes(newStatus)) {
    throw new ApiError(
      400,
      'INVALID_TRANSITION',
      `Cannot transition from '${currentStatus}' to '${newStatus}'`
    );
  }

  const accepting = currentStatus === 'placed' && newStatus === 'confirmed';
  if (currentStatus === 'placed' && !PLACED_EXIT_ROLES[newStatus]?.includes(actor?.role ?? 'system')) {
    throw new ApiError(409, ORDER_AWAITING_APPROVAL, 'This order is waiting for the restaurant to accept it');
  }

  // A dine-in round can't be cancelled while its table's bill is held for an online payment —
  // the guest would pay for food that is no longer on the bill (billing.service.js).
  if (newStatus === 'cancelled') {
    const target = await Order.findById(orderId).select('type tableSessionId').lean();
    await assertRoundCancellable(target);
  }

  const now = new Date();
  const historyEntry = {
    status: newStatus,
    at: now,
    byStaffId: actor?.staffId ?? staffId ?? null,
    byStaffName: actor?.staffName ?? null,
    byRole: actor?.role ?? 'system',
  };

  const set = { status: newStatus };
  if (newStatus === 'served') set.servedAt = now;
  if (newStatus === 'confirmed' && currentStatus === 'placed') set.acceptedAt = now;
  if (newStatus === 'cancelled') {
    set.cancelledAt = now;
    set.cancelledBy = CANCELLED_BY_ROLE[actor?.role] ?? 'system';
    set.cancellationReason = reason?.trim() || null;
    // A cancelled order must stop searching for a veg-fleet rider.
    set.vegFleetSearchDeadline = null;
  }

  const cancelGuard =
    newStatus === 'cancelled'
      ? {
          'deliveryAssignment.status': {
            $nin: CANCEL_BLOCKING_ASSIGNMENT[actor?.role] ?? CANCEL_BLOCKING_ASSIGNMENT.default,
          },
        }
      : {};
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: currentStatus,
      ...(accepting ? PAID_OR_OFFLINE : {}),
      ...cancelGuard,
      ...(guard ? { $and: [guard] } : {}),
    },
    { $set: set, $push: { statusHistory: historyEntry } },
    { new: true }
  );

  if (!order) {
    // Lost the compare-and-swap. Out of 'placed' that means one of two things, and the
    // owner needs to know which: the order is still waiting but unpaid, or someone else
    // (another owner tab, the timeout sweep, the customer) decided it first.
    if (currentStatus === 'placed') {
      const current = await Order.findById(orderId).select('status paymentMethod paymentStatus').lean();
      if (accepting && current?.status === 'placed') {
        throw new ApiError(
          409,
          'PAYMENT_PENDING',
          'The customer has not completed online payment for this order yet'
        );
      }
      throw new ApiError(
        409,
        'ORDER_ALREADY_DECIDED',
        'This order was just accepted or rejected from another screen — please refresh'
      );
    }
    throw new ApiError(
      409,
      'CONCURRENT_UPDATE',
      'Status was already changed by another request — please refresh'
    );
  }

  if (accepting) {
    // A veg-fleet order's rider search only begins now, so its customer-facing countdown
    // (screen 23) starts now too — not at checkout, which could be many minutes before the
    // restaurant accepted, and would have asked the customer to "keep waiting" for a rider
    // search that hadn't started. keepWaitingForVegFleet is exactly "start/restart the
    // countdown and tell the customer".
    if (order.vegFleetOptIn && order.vegFleetAssignmentStatus === 'searching') {
      await keepWaitingForVegFleet(order);
    }

    // Accepted: the order reaches the kitchen and the floor only now — this is the moment
    // it "arrives" for them, so they get the same new_order event a fresh ticket always did.
    notifyService.orderAccepted(order);
  }

  // Everything a cancellation sets off — a full refund of an online payment (and who bears
  // Razorpay's fee), or, for a customer walking away after the kitchen started, no refund and
  // the restaurant paid — is decided in one place: services/refund.service.js. The payment
  // handlers cover the other ordering (a payment captured after the order was cancelled).
  if (newStatus === 'cancelled') {
    // The rider (or a pending offer) is released first, so nobody collects the food while the
    // refund is being worked out.
    if (order.type === 'delivery') {
      const released = await releaseAssignmentForCancelledOrder(order._id);
      if (released.length) {
        const fresh = await Order.findById(order._id).select('deliveryAssignment').lean();
        if (fresh?.deliveryAssignment) order.set('deliveryAssignment', fresh.deliveryAssignment);
      }
    }
    const refreshed = await onOrderCancelled(order, {
      previousStatus: currentStatus,
      actorRole: actor?.role ?? 'system',
    });
    if (refreshed?.refund) {
      order.refund = refreshed.refund;
      order.refundStatus = refreshed.refundStatus;
      order.paymentStatus = refreshed.paymentStatus;
    }
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
    // The restaurant's credit for an order paid online (services/ledger.service.js).
    await onOrderDelivered(order);
    if (order.type === 'delivery') await countCompletedDelivery(order._id);
  }

  notifyService.orderStatusUpdated(order);
  return order;
};
