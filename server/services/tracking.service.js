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

// Masks a phone number so only the last 4 digits are visible, matching the
// standard practice of food-delivery platforms (Zomato, Swiggy, etc.) — the
// partner's personal number is not surfaced to the customer directly.
// A real masked-calling integration (e.g. Exotel, Knowlarity) would replace
// this with a dynamically-allocated proxy number; for now the UI gets a
// displayable masked string to show and open the native dialler with.
export const maskPhone = (phone) => {
  if (!phone || phone.length < 4) return null;
  const last4 = phone.slice(-4);
  const prefix = phone.startsWith('+') ? phone.slice(0, 3) : '+91';
  return `${prefix}XXXXXX${last4}`;
};

export const getOrderTracking = async (orderId, userId) => {
  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.type !== 'delivery') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only delivery orders can be tracked');
  }

  const restaurant = await Restaurant.findById(order.restaurantId)
    .select('name avgRating phone location')
    .lean();

  let deliveryPartner = null;
  let etaMinutes = null;

  const partnerId = order.deliveryAssignment?.partnerId;
  if (partnerId) {
    const partner = await DeliveryPartner.findById(partnerId).lean();
    if (partner) {
      const profilePhoto = partner.documents?.find((d) => d.type === 'profile_photo');
      deliveryPartner = {
        id: String(partner._id),
        name: partner.fullName || null,
        avatarUrl: profilePhoto?.url ?? null,
        rating: partner.rating,
        totalDeliveries: partner.totalDeliveries,
        usesVegOnlyFleetBag: order.dedicatedBagRequired,
        // Masked so the customer cannot see the partner's real phone number.
        // Open the native dialler with this; a real implementation would
        // allocate a proxy number via a telephony platform (Exotel, etc.).
        maskedPhone: maskPhone(partner.phone),
        vehicleType: partner.vehicle?.type ?? null,
        vehicleNumber: partner.vehicle?.number ?? null,
      };

      // Only computed for the picked_up leg (partner → customer) — matches the Figma
      // export, where "Arriving in X mins" only appears alongside the "On the way" pill,
      // not the earlier assigned-but-not-yet-picked-up phase. Only ever estimated from a
      // genuinely fresh location ping, never a stale/missing one.
      const isEnRouteToCustomer = order.deliveryAssignment.status === 'picked_up';
      if (isEnRouteToCustomer && isLocationFresh(partner.currentLocationUpdatedAt) && order.deliveryAddress?.coordinates) {
        const distanceKm = haversineKm(partner.currentLocation.coordinates, order.deliveryAddress.coordinates);
        etaMinutes = estimateEtaMinutes(distanceKm);
      }

      // Expose the partner's last known location so the tracking screen can show
      // the bike icon on the map without a separate socket round-trip on first load.
      // Only included when the location is genuinely fresh — a stale position is
      // more confusing than no position at all.
      if (isLocationFresh(partner.currentLocationUpdatedAt) && partner.currentLocation?.coordinates) {
        const [lng, lat] = partner.currentLocation.coordinates;
        deliveryPartner.currentLocation = { lat, lng };
      }
    }
  }

  return {
    orderId: String(order._id),
    restaurantId: String(order.restaurantId),
    status: order.status,
    // Delivery-assignment sub-status mirrors Order.deliveryAssignment.status —
    // 'unassigned' | 'assigned' | 'picked_up' | 'delivered' | 'failed'.
    // The tracking screen uses this alongside order.status to show finer-grained
    // copy ("Partner assigned, heading to restaurant" vs "On the way to you").
    assignmentStatus: order.deliveryAssignment?.status ?? 'unassigned',
    etaMinutes,
    timeline: buildTimeline(order),
    restaurant: {
      name: restaurant?.name ?? null,
      rating: restaurant?.avgRating ?? null,
      phone: restaurant?.phone ?? null,
      coordinates: restaurant?.location?.coordinates
        ? { lat: restaurant.location.coordinates[1], lng: restaurant.location.coordinates[0] }
        : null,
    },
    deliveryPartner,
    deliveryAddress: order.deliveryAddress ?? null,
    orderItems: order.items,
    paymentMethod: order.paymentMethod ?? null,
    paymentStatus: order.paymentStatus ?? null,
    totalPaid: order.grandTotal ?? order.subtotal,
  };
};
