// Road-accurate routing and traffic-aware ETAs via the HERE Routing API v8, replacing the
// straight-line estimates that geo.service.js still provides as the fallback.
//
// COST SHAPE — the reason this file is built the way it is.
// Routing bills per transaction. A rider pings every few seconds, so routing on every ping would
// be roughly 300-600 requests for one 30-minute delivery — which is absurd for a number that
// barely changes between two consecutive fixes. Real delivery platforms fetch a route once per
// leg and reuse it, re-routing only when it goes stale or the rider has actually moved somewhere
// the old route no longer describes. That is what the cache key below encodes: a route is reused
// until either ROUTE_TTL_SECONDS passes or the origin leaves its ~110 m bucket, whichever comes
// first. A 30-minute delivery lands around 15-20 requests instead of 600.
//
// Every export degrades rather than failing when HERE is unavailable (no key, quota, network):
// callers get a straight-line estimate with `source: 'estimate'` so the UI can hedge its wording.
// The tracking screen has to keep working when routing does not.

import { get as cacheGet, set as cacheSet } from './cache.service.js';
import { callHere, HERE_HOSTS, isHereEnabled, toHerePoint } from './here.service.js';
import { haversineKm, estimateEtaMinutes } from './geo.service.js';

// Long enough to keep the transaction count sane, short enough that a traffic ETA stays honest.
const ROUTE_TTL_SECONDS = 120;

// 3 decimal places ≈ 110 m. The origin is bucketed to this grid so a rider creeping along a
// street reuses one cached route instead of buying a new one every ping, while a genuine move to
// a different block misses the cache and re-routes.
const ORIGIN_PRECISION = 3;

// HERE's transport mode for two-wheelers. This matters more than it looks: scooter routing uses
// the lane filtering and the bike-legal shortcuts a delivery rider actually takes, which car
// routing refuses and which is most of the gap between a plausible ETA and a real one in Indian
// traffic. Falls back to `car` if HERE rejects the mode for a region.
const SCOOTER = 'scooter';
const CAR = 'car';

const bucket = (coordinates) =>
  `${coordinates[0].toFixed(ORIGIN_PRECISION)},${coordinates[1].toFixed(ORIGIN_PRECISION)}`;

/**
 * @typedef {object} Route
 * @property {string|null} polyline  HERE **flexible polyline** of the road path, for the map to
 *                                   draw. NOTE: this is not Google's encoded-polyline format —
 *                                   the client decodes it with src/lib/flexiblePolyline.ts.
 * @property {number}  distanceKm    Road distance, not straight-line.
 * @property {number}  durationMinutes Traffic-aware.
 * @property {'here'|'estimate'} source Which engine produced this, so the UI can hedge its copy.
 */

async function fetchRoute(origin, destination, transportMode) {
  const body = await callHere(HERE_HOSTS.routing, 'v8/routes', {
    origin: toHerePoint(origin),
    destination: toHerePoint(destination),
    transportMode,
    return: 'polyline,summary',
    // Without an explicit departure time HERE returns a free-flow duration — the number that
    // makes delivery apps look like liars at 8pm on a Friday. `now` is what enables live traffic.
    departureTime: 'now',
    alternatives: 0,
    lang: 'en-US',
  });

  const sections = body?.routes?.[0]?.sections;
  if (!Array.isArray(sections) || sections.length === 0) return null;

  // A route can come back split into sections (a mode change, a via point). For a single-mode
  // point-to-point request there is normally one, but summing rather than assuming costs nothing
  // and avoids silently reporting only the first leg of a two-part route.
  let seconds = 0;
  let metres = 0;
  for (const section of sections) {
    if (!Number.isFinite(section.summary?.duration) || !Number.isFinite(section.summary?.length)) {
      return null;
    }
    seconds += section.summary.duration;
    metres += section.summary.length;
  }

  // Only the first section's polyline is used. Concatenating flexible polylines is not a string
  // join — each one re-encodes its own header and restarts its deltas from zero — and a
  // multi-section route is rare enough here that drawing its first leg beats drawing garbage.
  const polyline = sections[0].polyline ?? null;
  if (!polyline) return null;

  return {
    polyline,
    distanceKm: Number((metres / 1000).toFixed(2)),
    durationMinutes: Math.max(1, Math.round(seconds / 60)),
    source: 'here',
  };
}

/**
 * Straight-line stand-in with the same shape as a real route, minus the polyline — the map draws
 * no line rather than a fake one, which is the honest failure mode: customers read a drawn line
 * as the road the rider is on. Used when HERE is unconfigured or unreachable.
 */
const estimatedRoute = (origin, destination) => {
  const distanceKm = Number(haversineKm(origin, destination).toFixed(2));
  return {
    polyline: null,
    distanceKm,
    durationMinutes: estimateEtaMinutes(distanceKm),
    source: 'estimate',
  };
};

/**
 * Road route between two GeoJSON `[lng, lat]` points. `cacheKey` namespaces the cache entry to
 * one order-leg so two orders heading to the same building never share a rider's route.
 *
 * Never throws and never returns null for valid input: without HERE it degrades to
 * {@link estimatedRoute}, so callers always have a distance and an ETA to show.
 *
 * @returns {Promise<Route|null>}
 */
export async function getRoute(origin, destination, { cacheKey, mode = SCOOTER } = {}) {
  if (!Array.isArray(origin) || !Array.isArray(destination)) return null;
  if (!isHereEnabled()) return estimatedRoute(origin, destination);

  const key = `route:${cacheKey ?? 'adhoc'}:${bucket(origin)}:${bucket(destination)}:${mode}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  // A null from fetchRoute is indistinguishable between "scooter unsupported here" and any other
  // failure, so retry once as a car before giving up on a real route entirely.
  const route =
    (await fetchRoute(origin, destination, mode)) ??
    (mode === SCOOTER ? await fetchRoute(origin, destination, CAR) : null);

  if (!route) return estimatedRoute(origin, destination);

  await cacheSet(key, route, ROUTE_TTL_SECONDS);
  return route;
}

/**
 * ETA for a two-leg journey the rider has not started yet: partner → restaurant → customer, plus
 * however long the kitchen still needs. This is what lets the customer see an arrival time from
 * the moment they pay, instead of only after pickup.
 *
 * `remainingPrepMinutes` is clamped at zero by the caller so a late kitchen never subtracts from
 * the ETA. The rider cannot leave before the food is ready, so the pickup leg and the remaining
 * prep OVERLAP — hence `Math.max` of the two rather than their sum.
 */
export async function getTwoLegEta(partnerCoords, restaurantCoords, customerCoords, opts = {}) {
  const { remainingPrepMinutes = 0, cacheKey } = opts;

  const dropLeg = await getRoute(restaurantCoords, customerCoords, { cacheKey: `${cacheKey}:drop` });
  if (!dropLeg) return null;

  const pickupLeg = partnerCoords
    ? await getRoute(partnerCoords, restaurantCoords, { cacheKey: `${cacheKey}:pickup` })
    : null;

  const untilPickup = Math.max(pickupLeg?.durationMinutes ?? 0, Math.max(0, remainingPrepMinutes));

  return {
    etaMinutes: Math.max(1, Math.round(untilPickup + dropLeg.durationMinutes)),
    dropLeg,
    pickupLeg,
    source: dropLeg.source,
  };
}
