import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { ApiError } from '../utils/ApiError.js';
import { haversineKm, estimateEtaMinutes, isLocationFresh } from './geo.service.js';
import { getRoute, getTwoLegEta } from './routing.service.js';

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
    // A cancelled order (most often one the restaurant rejected) has no position on the
    // happy path, so `currentIndex` is -1 — which used to mark even 'placed' as never
    // reached. The stages it genuinely passed through are the ones in its history; the
    // cancellation itself is reported separately as `cancellation` on the payload.
    const completed =
      order.status === 'delivered'
        ? true
        : order.status === 'cancelled'
          ? stage === 'placed' || historyAt.has(stage)
          : index <= currentIndex;

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

// Assumed kitchen time when a restaurant has not configured `delivery.estimatedMinutes`. Only
// ever used to decide how much prep is LEFT, which is then clamped at zero — so an over-generous
// default can delay an ETA but can never invent a journey shorter than the road allows.
const DEFAULT_PREP_MINUTES = 18;

// Prep is counted from when the kitchen accepted, not from checkout: an order sitting unconfirmed
// has not started cooking, so counting from `createdAt` would quietly burn down an ETA while
// nothing was actually happening.
const remainingPrepMinutes = (order, restaurant) => {
  if (['ready', 'out_for_delivery', 'delivered'].includes(order.status)) return 0;

  const totalPrep = restaurant?.delivery?.estimatedMinutes ?? DEFAULT_PREP_MINUTES;
  // Still waiting for the restaurant to accept: nothing is cooking yet, so the whole prep
  // time is still ahead. Falling through to `createdAt` here would count the minutes the
  // order spent waiting for approval as minutes of cooking.
  if (order.status === 'placed') return totalPrep;

  const acceptedAt =
    order.acceptedAt ??
    (order.statusHistory ?? []).find((entry) => entry.status === 'confirmed')?.at ??
    order.createdAt;
  const elapsedMinutes = (Date.now() - new Date(acceptedAt).getTime()) / 60_000;

  return Math.max(0, Math.round(totalPrep - elapsedMinutes));
};

/**
 * Builds the ETA and the map route for whichever leg of the journey is actually happening.
 *
 * There are three phases, and a mature tracking screen shows a number in all three — showing
 * nothing until pickup (which is what this used to do) is the single most common complaint
 * about home-grown tracking:
 *
 *   before a rider is assigned  -> prep time + the restaurant->customer drive
 *   rider heading to restaurant -> max(prep left, rider->restaurant) + the drop leg
 *   rider carrying the food     -> just the rider->customer leg, and the map draws that route
 *
 * Returns nulls rather than throwing when coordinates are missing (an address saved before
 * geocoding existed, a restaurant with no pin); the screen simply omits the ETA.
 */
async function buildEtaAndRoute(order, restaurant, partner) {
  // `usablePoint`, not a truthiness check: an address whose geocode failed can hold an empty
  // coordinates array, which is truthy and would send `[]` to the routing API as an origin.
  const usablePoint = (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite);
  const customerCoords = usablePoint(order.deliveryAddress?.coordinates)
    ? order.deliveryAddress.coordinates
    : null;
  const restaurantCoords = usablePoint(restaurant?.location?.coordinates)
    ? restaurant.location.coordinates
    : null;
  if (!customerCoords || !restaurantCoords) return { etaMinutes: null, route: null, etaSource: null };

  const assignmentStatus = order.deliveryAssignment?.status ?? 'unassigned';
  const partnerCoords =
    partner && isLocationFresh(partner.currentLocationUpdatedAt)
      ? partner.currentLocation?.coordinates ?? null
      : null;

  // Carrying the food: the only leg left is rider -> customer, and it is the one worth drawing.
  if (assignmentStatus === 'picked_up' && partnerCoords) {
    const route = await getRoute(partnerCoords, customerCoords, { cacheKey: `order:${order._id}:drop` });
    return { etaMinutes: route?.durationMinutes ?? null, route, etaSource: route?.source ?? null };
  }

  const twoLeg = await getTwoLegEta(partnerCoords, restaurantCoords, customerCoords, {
    remainingPrepMinutes: remainingPrepMinutes(order, restaurant),
    cacheKey: `order:${order._id}`,
  });
  if (!twoLeg) return { etaMinutes: null, route: null, etaSource: null };

  // Before pickup the useful line on the map is the rider's approach to the restaurant; when
  // there is no rider yet, the drop leg previews where the food is going.
  const route = assignmentStatus === 'assigned' && twoLeg.pickupLeg ? twoLeg.pickupLeg : twoLeg.dropLeg;
  return { etaMinutes: twoLeg.etaMinutes, route, etaSource: twoLeg.source };
}

export const getOrderTracking = async (orderId, userId) => {
  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.type !== 'delivery') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only delivery orders can be tracked');
  }

  const restaurant = await Restaurant.findById(order.restaurantId)
    .select('name avgRating phone location delivery.estimatedMinutes')
    .lean();

  const partnerId = order.deliveryAssignment?.partnerId;
  const partner = partnerId ? await DeliveryPartner.findById(partnerId).lean() : null;

  let deliveryPartner = null;
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

    // Expose the partner's last known location so the tracking screen can show the rider on the
    // map without a separate socket round-trip on first load. Only when the ping is genuinely
    // fresh — a stale position is more confusing than no position at all.
    //
    // Deliberately NOT gated on `picked_up`: watching the rider approach the restaurant is a
    // headline feature of every mature delivery app, and the socket broadcast in
    // controllers/partner/location.controller.js now covers the same window.
    if (isLocationFresh(partner.currentLocationUpdatedAt) && partner.currentLocation?.coordinates) {
      const [lng, lat] = partner.currentLocation.coordinates;
      deliveryPartner.currentLocation = { lat, lng };
    }
  }

  // A cancelled order (rejected, timed out) is never arriving: no ETA, no route, and no
  // paid routing call spent on it every time the tracking screen polls.
  const { etaMinutes, route, etaSource } =
    order.status === 'cancelled'
      ? { etaMinutes: null, route: null, etaSource: null }
      : await buildEtaAndRoute(order, restaurant, partner);

  return {
    orderId: String(order._id),
    restaurantId: String(order.restaurantId),
    status: order.status,
    // 'placed' now means "sent to the restaurant, waiting for them to accept". The tracking
    // screen says so explicitly rather than implying the kitchen has started.
    awaitingRestaurantApproval: order.status === 'placed',
    acceptedAt: order.acceptedAt ?? null,
    // Set when the restaurant rejected the order (or it was cancelled later) — the
    // customer-facing reason.
    cancellation:
      order.status === 'cancelled'
        ? {
            reason: order.cancellationReason ?? null,
            by: order.cancelledBy ?? null,
            at: order.cancelledAt ?? null,
          }
        : null,
    // Delivery-assignment sub-status mirrors Order.deliveryAssignment.status —
    // 'unassigned' | 'assigned' | 'picked_up' | 'delivered' | 'failed'.
    // The tracking screen uses this alongside order.status to show finer-grained
    // copy ("Partner assigned, heading to restaurant" vs "On the way to you").
    assignmentStatus: order.deliveryAssignment?.status ?? 'unassigned',
    etaMinutes,
    // 'here' when the number came from traffic-aware road routing, 'estimate' when it fell back
    // to straight-line distance. The app hedges its wording on this rather than presenting a
    // rough guess with the same confidence as a real routing answer.
    etaSource,
    // HERE **flexible polyline** of the leg currently in progress, for the map to draw. Not the
    // same encoding as Google's encoded polyline — the app decodes it with
    // src/lib/flexiblePolyline.ts. Null whenever routing is unavailable, in which case the map
    // shows markers only rather than a fabricated straight line.
    route: route ? { polyline: route.polyline, distanceKm: route.distanceKm } : null,
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
