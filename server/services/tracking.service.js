import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { ApiError } from '../utils/ApiError.js';
import { haversineKm, estimateEtaMinutes, isLocationFresh } from './geo.service.js';

// Order.statusHistory now records every accepted transition with its own timestamp, so a
// completed stage can carry a real time rather than a null. Where it's missing — orders
// placed before that field existed — the original fallbacks still apply, because
// updatedAt only ever reflects the LAST write and is trustworthy only for whichever stage
// is the order's CURRENT status: 'placed' falls back to createdAt (always real),
// 'delivered' to deliveredAt (always real), the current stage to updatedAt, and
// 'out_for_delivery' prefers deliveryAssignment.pickupOtpVerifiedAt when set (a more
// precise, independently real signal of when the partner actually picked up). Any other
// already-completed stage with no history entry still gets null rather than a guess.
const STATUS_STAGES = ['placed', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'];

const buildTimeline = (order) => {
  const currentIndex = STATUS_STAGES.indexOf(order.status);
  const historyAt = new Map(
    (order.statusHistory ?? []).map((entry) => [entry.status, entry.at])
  );

  return STATUS_STAGES.map((stage, index) => {
    const completed = order.status === 'delivered' ? true : index <= currentIndex;

    let timestamp = historyAt.get(stage) ?? null;
    if (timestamp) return { stage, timestamp, completed };

    if (stage === 'placed') {
      timestamp = order.createdAt;
    } else if (stage === 'delivered') {
      timestamp = order.deliveredAt;
    } else if (stage === 'out_for_delivery') {
      timestamp =
        order.deliveryAssignment?.pickupOtpVerifiedAt ?? (order.status === stage ? order.updatedAt : null);
    } else if (order.status === stage) {
      timestamp = order.updatedAt;
    }

    return { stage, timestamp: timestamp ?? null, completed };
  });
};

export const getOrderTracking = async (orderId, userId) => {
  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.type !== 'delivery') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only delivery orders can be tracked');
  }

  const restaurant = await Restaurant.findById(order.restaurantId).select('name avgRating').lean();

  let deliveryPartner = null;
  let etaMinutes = null;

  const partnerId = order.deliveryAssignment?.partnerId;
  if (partnerId) {
    const partner = await DeliveryPartner.findById(partnerId).lean();
    if (partner) {
      const profilePhoto = partner.documents?.find((d) => d.type === 'profile_photo');
      deliveryPartner = {
        name: partner.fullName || null,
        avatarUrl: profilePhoto?.url ?? null,
        rating: partner.rating,
        totalDeliveries: partner.totalDeliveries,
        usesVegOnlyFleetBag: order.dedicatedBagRequired,
      };

      // Only computed for the picked_up leg (partner -> customer) — matches the Figma
      // export, where "Arriving in X mins" only appears alongside the "On the way" pill,
      // not the earlier assigned-but-not-yet-picked-up phase. Only ever estimated from a
      // genuinely fresh location ping, never a stale/missing one.
      const isEnRouteToCustomer = order.deliveryAssignment.status === 'picked_up';
      if (isEnRouteToCustomer && isLocationFresh(partner.currentLocationUpdatedAt) && order.deliveryAddress?.coordinates) {
        const distanceKm = haversineKm(partner.currentLocation.coordinates, order.deliveryAddress.coordinates);
        etaMinutes = estimateEtaMinutes(distanceKm);
      }
    }
  }

  return {
    status: order.status,
    etaMinutes,
    timeline: buildTimeline(order),
    restaurant: { name: restaurant?.name ?? null, rating: restaurant?.avgRating ?? null },
    deliveryPartner,
    orderItems: order.items,
    totalPaid: order.grandTotal ?? order.subtotal,
  };
};
