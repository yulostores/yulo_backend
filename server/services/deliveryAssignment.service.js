import Order from '../models/Order.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import Restaurant from '../models/Restaurant.js';
import User from '../models/User.js';
import { redis } from '../config/redis.js';
import { maxConcurrentOrdersPerPartner, perDeliveryRate, offerWindowSeconds } from '../config/finance.config.js';
import { getIO } from '../socket.js';
import { notifyService } from './notify.service.js';
import logger from '../utils/logger.js';
import { computeDropKm, computePickupKm, isLocationFresh, LOCATION_FRESHNESS_SECONDS } from './geo.service.js';
import { formatAddress as formatPostalAddress } from './geocode.service.js';

// How long a strict veg-fleet-only search runs before the customer is asked to decide
// (screen 23) — matches that screen's ~3-minute countdown example. Set at order
// placement (services/order.service.js's createOrderFromCart) and reset to this same
// length by keepWaitingForVegFleet/sweepExpiredVegFleetSearches below.
export const VEG_FLEET_SEARCH_WINDOW_MS = 3 * 60 * 1000;

// A partner-facing app now exists (Delivery-Partner). Assignment works as a real-time offer,
// not a silent write: the best eligible connected candidate gets an `order_offer` socket event
// with a fixed acceptance window; they accept/reject via the partner API, or the offer times
// out and re-offers to the next candidate. See acceptOrder/rejectOrder in
// controllers/partner/order.controller.js and sweepExpiredOffers below.

export const countActiveAssignments = (partnerId) =>
  Order.countDocuments({
    'deliveryAssignment.partnerId': partnerId,
    'deliveryAssignment.status': { $in: ['assigned', 'picked_up'] },
  });

// Reuses the geocoder's single-line formatter rather than a second, narrower one of its
// own — the local version joined only street and city, so the PIN and state the partner
// actually navigates by were dropped from the drop address even once the order carried
// them. Both a Restaurant.address and an Order.deliveryAddress have the same four fields,
// so one formatter covers both.
const formatAddress = (addr) => formatPostalAddress(addr ?? {}) || null;

// Distance-based ranking now that partner location tracking exists (see services/geo.service.js).
// Partners with a fresh (< LOCATION_FRESHNESS_SECONDS old) location ping within the restaurant's
// own configured delivery radius are ranked by actual proximity first — $near already returns
// them nearest-first. Everyone else (never pinged yet, or pinged too long ago to trust) still
// gets a fallback chance ranked by the original rating heuristic, so this is a strict improvement:
// no candidate is ever silently excluded just because they haven't started sending location pings
// (a realistic transitional state for a brand-new capability, not an edge case to ignore).
//
// `requireFleetType` — when set (autoAssign passes 'veg' while an order's veg-fleet search is
// still strictly 'searching', never once it's relaxed to 'fallback_any_partner') — restricts
// candidates to that fleetType up front. Omitted entirely, behavior is byte-for-byte what it
// was before veg-fleet existed: every active/approved partner is eligible, exactly as today.
const rankCandidates = async (restaurant, { requireFleetType } = {}) => {
  const baseFilter = { status: 'active', verificationStatus: 'approved' };
  if (requireFleetType) baseFilter.fleetType = requireFleetType;

  if (!restaurant?.location?.coordinates) {
    // No restaurant location on record — shouldn't normally happen (Restaurant.location is
    // required), but fall back entirely rather than crash a real order flow over it.
    return DeliveryPartner.find(baseFilter).sort({ rating: -1, totalDeliveries: 1 }).lean();
  }

  const freshCutoff = new Date(Date.now() - LOCATION_FRESHNESS_SECONDS * 1000);
  const maxDistanceMeters = (restaurant.delivery?.radiusKm ?? 5) * 1000;

  const nearby = await DeliveryPartner.find({
    ...baseFilter,
    currentLocationUpdatedAt: { $gte: freshCutoff },
    currentLocation: {
      $near: { $geometry: restaurant.location, $maxDistance: maxDistanceMeters },
    },
  }).lean();

  const nearbyIds = new Set(nearby.map((p) => p._id.toString()));
  const fallback = await DeliveryPartner.find({ ...baseFilter, _id: { $nin: [...nearbyIds] } })
    .sort({ rating: -1, totalDeliveries: 1 })
    .lean();

  return [...nearby, ...fallback];
};

// Shape matches Delivery-Partner/src/mocks/fixtures.js's mockOrders (veg/standard examples) field
// for field, since IncomingOrder.jsx will eventually consume this directly. Exported so
// GET /api/partner/orders/current (controllers/partner/order.controller.js) can return the exact
// same shape for an app that was backgrounded mid-offer, not just the live socket push.
export const buildOfferPayload = async (order, candidate) => {
  // The account lookup is only a fallback for orders placed before Order.customerName/
  // customerPhone were snapshotted — a current order carries its own, and the address
  // carries the door contact, which is who the partner actually needs to reach and is not
  // necessarily the account holder (an order sent to a parent's house).
  const needsUserLookup = order.userId && !order.customerName && !order.customerPhone;
  const [restaurant, customer] = await Promise.all([
    Restaurant.findById(order.restaurantId).select('name address location').lean(),
    needsUserLookup ? User.findById(order.userId).select('name phone').lean() : null,
  ]);

  const dropKm = computeDropKm(restaurant, order);
  // Real when the candidate has a fresh location ping, null otherwise — never estimated from a
  // stale or missing position.
  const pickupKm = isLocationFresh(candidate.currentLocationUpdatedAt)
    ? computePickupKm(candidate.currentLocation, restaurant)
    : null;

  return {
    orderId: order._id,
    restaurantName: restaurant?.name ?? null,
    restaurantAddress: formatAddress(restaurant?.address),
    // fleetType reflects the PARTNER being offered this order (fixed per-partner, same on
    // every offer they get) — separate from vegFleetOptIn/dedicatedBagRequired below,
    // which reflect what THIS order asked for. Order.vegFleetOptIn now exists (this is
    // that placeholder finally filled in — see rankCandidates), but a candidate's own
    // fleetType is still never derived from the order; rankCandidates' requireFleetType
    // is what connects the two, before a candidate ever reaches this payload.
    fleetType: candidate.fleetType,
    vegFleetOptIn: order.vegFleetOptIn,
    dedicatedBagRequired: order.dedicatedBagRequired,
    // "Instructions for delivery partner" (screen 19) — cookingRequests/extraCutlery are
    // restaurant-fulfillment toggles instead (see notify.service.js's newOrder payload).
    deliveryInstructions: order.deliveryInstructions || '',
    pickupKm,
    dropKm,
    totalKm: pickupKm != null && dropKm != null ? Number((pickupKm + dropKm).toFixed(1)) : null,
    // Flat-rate estimate, same rate the admin payout system already uses — becomes the real
    // itemized basePay/distancePay/surge/tip breakdown once the itemized-earnings step exists;
    // not fabricating a distance-based fare formula ahead of that.
    fare: perDeliveryRate,
    payment: order.paymentMethod === 'cash' ? 'cod' : 'prepaid',
    codAmount: order.paymentMethod === 'cash' ? order.subtotal : undefined,
    items: order.items.map((i) => ({ name: i.name, qty: i.quantity })),
    // Who is at the door, and how to reach them. The partner had a name (which was always
    // null, since nothing ever set User.name) and no number whatsoever — so the one thing
    // a partner does when they can't find a flat, call the customer, was impossible.
    customerName:
      order.deliveryAddress?.contactName || order.customerName || customer?.name || null,
    customerPhone:
      order.deliveryAddress?.contactPhone || order.customerPhone || customer?.phone || null,
    customerAddress: formatAddress(order.deliveryAddress),
    // Still no real routing/ETA engine (straight-line distance ≠ travel time) — see the
    // geo.service.js file comment on why that's a separate, larger capability than this step adds.
    customerEtaMin: null,
    pickupEtaMin: null,
    countdownSeconds: offerWindowSeconds,
  };
};

export const autoAssign = async (order) => {
  if (order.type !== 'delivery') return null;

  const alreadyTried = new Set(
    (order.deliveryAssignment?.history || []).map((h) => h.partnerId?.toString()).filter(Boolean)
  );
  if (order.deliveryAssignment?.partnerId) {
    alreadyTried.add(order.deliveryAssignment.partnerId.toString());
  }

  const onlinePartnerIds = new Set(await redis.smembers('live:active_partners'));

  const restaurant = await Restaurant.findById(order.restaurantId).select('location delivery.radiusKm').lean();

  // Strictly veg-fleet-only while still 'searching' — once the customer (or the
  // auto-extend sweep, which never does this itself) explicitly relaxes it via
  // POST .../veg-fleet/fallback, vegFleetAssignmentStatus becomes 'fallback_any_partner'
  // and this condition stops applying, same as a normal (non-veg-fleet) order from then on.
  const requireFleetType =
    order.vegFleetOptIn && order.vegFleetAssignmentStatus === 'searching' ? 'veg' : undefined;
  const candidates = await rankCandidates(restaurant, { requireFleetType });

  for (const candidate of candidates) {
    const candidateId = candidate._id.toString();
    if (alreadyTried.has(candidateId)) continue;
    if (!onlinePartnerIds.has(candidateId)) continue;

    const activeCount = await countActiveAssignments(candidate._id);
    if (activeCount >= maxConcurrentOrdersPerPartner) continue;

    // A candidate mid-offer on a different order shouldn't be offered a second one at the same
    // time — not asked for explicitly, but without this a partner could get two simultaneous
    // `order_offer` pushes, which IncomingOrder.jsx has no UI for.
    const busyWithAnotherOffer = await Order.exists({
      _id: { $ne: order._id },
      'deliveryAssignment.offeredTo': candidate._id,
      'deliveryAssignment.offerStatus': 'offered',
      'deliveryAssignment.offerExpiresAt': { $gt: new Date() },
    });
    if (busyWithAnotherOffer) continue;

    const offerExpiresAt = new Date(Date.now() + offerWindowSeconds * 1000);
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          'deliveryAssignment.offeredTo': candidate._id,
          'deliveryAssignment.offerExpiresAt': offerExpiresAt,
          'deliveryAssignment.offerStatus': 'offered',
        },
      }
    );

    const payload = await buildOfferPayload(order, candidate);
    try {
      getIO().to(`partner:${candidateId}`).emit('order_offer', payload);
    } catch (err) {
      logger.error({ err, orderId: order._id, partnerId: candidateId }, 'Failed to emit order_offer');
    }

    return candidate._id;
  }

  // No eligible partner right now — leave unassigned. Never throw: this must not
  // block the kitchen's own status transition. Visible/reassignable by admin later.
  // For a strict veg-fleet search this is expected and not an error state:
  // vegFleetAssignmentStatus simply stays 'searching' (already set at order placement),
  // and the individual-offer retry loop (sweepExpiredOffers, unchanged) keeps calling
  // back in here on its normal cadence for as long as vegFleetSearchDeadline hasn't
  // passed — see sweepExpiredVegFleetSearches below for what happens once it does.
  return null;
};

// Timeout strategy: no cron/job-queue dependency exists anywhere in this codebase, and
// payout.service.js's ensurePayoutForPeriod already establishes a "compute freshness on read"
// convention for time-based state instead of a scheduler. That convention alone isn't enough
// here, though — an offer nobody ever reads again (app closed, partner never taps anything) would
// sit 'offered' forever with no natural trigger to free it up. So this uses BOTH: expireIfStale
// is the lazy on-read check (called from GET /orders/current and the accept/reject endpoints,
// consistent with ensurePayoutForPeriod's philosophy), and sweepExpiredOffers is a small periodic
// scan — the same shape as the live_visitor_update setInterval socket.js already runs every 30s,
// just on a tighter interval to match a ~20s offer window. Neither is a new dependency.
const expireAndReassign = async (order) => {
  const now = new Date();
  order.deliveryAssignment.offerStatus = 'expired';
  order.deliveryAssignment.history.push({
    partnerId: order.deliveryAssignment.offeredTo,
    assignedAt: order.deliveryAssignment.offerExpiresAt,
    assignedBy: 'auto',
    unassignedAt: now,
    reason: 'expired',
  });
  await order.save();
  return autoAssign(order);
};

export const expireIfStale = async (order) => {
  const isStaleOffer =
    order.deliveryAssignment?.offerStatus === 'offered' &&
    order.deliveryAssignment.offerExpiresAt &&
    order.deliveryAssignment.offerExpiresAt <= new Date();

  if (!isStaleOffer) return false;
  await expireAndReassign(order);
  return true;
};

export const sweepExpiredOffers = async () => {
  const staleOrders = await Order.find({
    type: 'delivery',
    'deliveryAssignment.offerStatus': 'offered',
    'deliveryAssignment.offerExpiresAt': { $lte: new Date() },
  });

  for (const order of staleOrders) {
    try {
      await expireAndReassign(order);
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Failed to expire/reassign stale offer');
    }
  }
};

// POST /api/orders/:id/veg-fleet/keep-waiting — resets the countdown, status stays
// 'searching'. Also what the auto-extend sweep below calls when nobody acts before the
// deadline (screen 23: "Auto-defaults to keep waiting").
export const keepWaitingForVegFleet = async (order) => {
  order.vegFleetSearchDeadline = new Date(Date.now() + VEG_FLEET_SEARCH_WINDOW_MS);
  await order.save();
  notifyService.vegFleetStatusUpdated(order);
  return order;
};

// POST /api/orders/:id/veg-fleet/fallback — the customer's explicit "send any available
// partner" choice. dedicatedBagRequired is deliberately left untouched (stays true): even
// on fallback, screen 23 promises a sanitised, unbatched bag — this only relaxes WHICH
// partner may be offered the order, not the hygiene guarantee itself.
export const fallbackVegFleet = async (order) => {
  order.vegFleetAssignmentStatus = 'fallback_any_partner';
  order.vegFleetSearchDeadline = null;
  await order.save();
  notifyService.vegFleetStatusUpdated(order);

  // Retry immediately with the now-relaxed constraint rather than waiting for the next
  // sweep cycle — the customer just explicitly asked for any partner, so there's no
  // reason to make them wait an extra ~5s for the next scheduled pass.
  await autoAssign(order);
  return order;
};

// Companion to sweepExpiredOffers above, run from the same setInterval in socket.js — no
// new job scheduler. Does two things for every order still actively searching for a
// veg-fleet partner with nothing currently in flight (excludes orders with a live
// 'offered' state — sweepExpiredOffers already owns retrying those specifically, once
// THAT offer expires):
//   1. If the search deadline has passed with no assignment and no customer decision,
//      auto-default to keep-waiting (extend the deadline) rather than relaxing to
//      any-partner — matches screen 23's own copy exactly.
//   2. Retry autoAssign regardless, so a veg-fleet partner coming online moments after
//      the original (empty) candidate pool still gets offered this order well within the
//      search window, not only once at the initial kitchen-confirm attempt.
export const sweepExpiredVegFleetSearches = async () => {
  const now = new Date();
  const searching = await Order.find({
    vegFleetAssignmentStatus: 'searching',
    'deliveryAssignment.status': 'unassigned',
    'deliveryAssignment.offerStatus': { $ne: 'offered' },
  });

  for (const order of searching) {
    try {
      if (order.vegFleetSearchDeadline && order.vegFleetSearchDeadline <= now) {
        await keepWaitingForVegFleet(order);
      }
      await autoAssign(order);
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Failed to sweep veg-fleet search');
    }
  }
};
