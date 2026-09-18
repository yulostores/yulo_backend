// Real geo capability for the delivery-partner backend — filled in now that partner location
// tracking exists (DeliveryPartner.currentLocation). Three prior steps (order offers, delivery
// execution, itemized earnings) each explicitly flagged this file as an empty placeholder
// reserved for exactly this moment rather than bolting a formula on ahead of it; this is that
// moment.
//
// A real routing/ETA engine DOES now exist — see services/routing.service.js, which uses the HERE
// Routing API for road distance and traffic-aware durations. This file is what that falls back
// to: haversine + MongoDB's native 2dsphere/$near give real (not fabricated) straight-line
// distance with no external dependency, so the platform keeps working when HERE_API_KEY is unset
// or HERE is unreachable. Anything customer-facing that uses these numbers is expected to say so
// (the tracking payload carries `etaSource: 'estimate'` for exactly that reason), because a
// straight-line estimate is a materially worse number than a routed one and should not be
// presented with the same confidence.

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

export const haversineKm = ([lng1, lat1], [lng2, lat2]) => {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const computeDropKm = (restaurant, order) =>
  restaurant?.location?.coordinates && order.deliveryAddress?.coordinates
    ? Number(haversineKm(restaurant.location.coordinates, order.deliveryAddress.coordinates).toFixed(1))
    : null;

export const computePickupKm = (partnerLocation, restaurant) =>
  partnerLocation?.coordinates && restaurant?.location?.coordinates
    ? Number(haversineKm(partnerLocation.coordinates, restaurant.location.coordinates).toFixed(1))
    : null;

// How long a partner's last location ping stays trustworthy for ranking/display — older than
// this and we no longer really know where they are, so they fall back to the rating-based
// heuristic instead of being ranked (or shown to a customer) by a potentially-stale position.
// The app's location-ping interval (once built) needs to fire more often than this to keep a
// partner in the "known location" pool.
export const LOCATION_FRESHNESS_SECONDS = 120;

export const isLocationFresh = (currentLocationUpdatedAt) =>
  Boolean(currentLocationUpdatedAt) &&
  new Date(currentLocationUpdatedAt).getTime() >= Date.now() - LOCATION_FRESHNESS_SECONDS * 1000;

// Straight-line-distance/avg-speed estimate for the customer tracking screen's
// "Arriving in X mins" — same "no real routing/ETA engine" reasoning as the rest of this
// file (see the header comment); an assumed flat urban two-wheeler speed, not a
// traffic-aware prediction. `Math.max(1, ...)` avoids ever showing "0 mins" for a very
// short remaining distance.
const AVERAGE_DELIVERY_SPEED_KMH = 20;

export const estimateEtaMinutes = (distanceKm) =>
  distanceKm != null ? Math.max(1, Math.round((distanceKm / AVERAGE_DELIVERY_SPEED_KMH) * 60)) : null;
