// /api/geo/* — the customer app's window onto HERE Geocoding & Search and this platform's
// serviceability rules.
//
// See services/here.service.js for why these are proxied rather than called from the device even
// though the app already carries a HERE key for map tiles. They are behind `authenticate` because
// every call here costs a HERE transaction, and an unauthenticated caller must not be able to run
// up the bill.

import { z } from 'zod';
import Restaurant from '../models/Restaurant.js';
import { autocomplete, reverseGeocode } from '../services/places.service.js';
import { haversineKm } from '../services/geo.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// [lng, lat], GeoJSON order — the same order every other coordinates field in this codebase uses.
const coordinates = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const parseCoordParam = (value) => {
  const parts = String(value ?? '').split(',').map(Number);
  const result = coordinates.safeParse(parts);
  return result.success ? result.data : null;
};

// GET /api/geo/autocomplete?q=&near=lng,lat
//
// `near` is required rather than optional: HERE's autosuggest endpoint has no unanchored mode, so
// a missing anchor is a 400 from HERE rather than a wider search. Rejecting it here turns that
// into a clear error instead of a silently empty result list.
export const searchPlaces = asyncHandler(async (req, res) => {
  const near = parseCoordParam(req.query.near);
  if (!near) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid `near=lng,lat` is required');

  const suggestions = await autocomplete(String(req.query.q ?? ''), { near });
  sendSuccess(res, 200, 'Suggestions fetched', { suggestions });
});

// GET /api/geo/reverse?at=lng,lat
//
// Returns `{ place: null }` rather than a 404 when nothing resolves: "no address here" is an
// ordinary outcome for a pin in the middle of a field, and the app falls back to its on-device
// geocoder. A 404 would make that normal case look like a failure in the logs.
export const reverse = asyncHandler(async (req, res) => {
  const at = parseCoordParam(req.query.at);
  if (!at) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid `at=lng,lat` is required');
  sendSuccess(res, 200, 'Reverse geocoded', { place: await reverseGeocode(at) });
});

// How far out to look for a restaurant that might cover this pin. Nothing on the platform has a
// radius anywhere near this; it only bounds the candidate set before each restaurant's own radius
// is applied below.
const SERVICEABILITY_SEARCH_KM = 25;

// GET /api/geo/serviceability?at=lng,lat
//
// Answers "will anything actually deliver here?" before the customer saves the address and
// discovers an empty home feed. Delivery radius is per-restaurant (Restaurant.delivery.radiusKm),
// so a single $maxDistance query cannot answer this on its own — it narrows the candidates, then
// each restaurant's own radius decides. `$near` returns nearest-first, so the first match found
// this way is also the closest serviceable one.
export const serviceability = asyncHandler(async (req, res) => {
  const at = parseCoordParam(req.query.at);
  if (!at) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid `at=lng,lat` is required');

  const candidates = await Restaurant.find({
    isActive: true,
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: at },
        $maxDistance: SERVICEABILITY_SEARCH_KM * 1000,
      },
    },
  })
    .select('location delivery.radiusKm')
    .limit(200)
    .lean();

  let serviceableCount = 0;
  let nearestKm = null;

  for (const restaurant of candidates) {
    const distanceKm = haversineKm(at, restaurant.location.coordinates);
    if (distanceKm <= (restaurant.delivery?.radiusKm ?? 5)) {
      serviceableCount += 1;
      if (nearestKm === null) nearestKm = Number(distanceKm.toFixed(1));
    }
  }

  sendSuccess(res, 200, 'Serviceability checked', {
    serviceable: serviceableCount > 0,
    restaurantCount: serviceableCount,
    nearestKm,
  });
});
