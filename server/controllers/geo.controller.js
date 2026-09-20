// /api/geo/* — the customer app's window onto HERE Geocoding & Search and this platform's
// serviceability rules.
//
// See services/here.service.js for why these are proxied rather than called from the device even
// though the app already carries a HERE key for map tiles. They are behind `authenticate` because
// every call here costs a HERE transaction, and an unauthenticated caller must not be able to run
// up the bill.

import { z } from 'zod';
import { autocomplete, reverseGeocode } from '../services/places.service.js';
import { checkServiceability } from '../services/restaurant.service.js';
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

// GET /api/geo/serviceability?at=lng,lat
//
// Answers "will anything actually deliver here?" before the customer saves the address and
// discovers an empty home feed. It runs the SAME rules the home feed and the restaurant list
// use (services/restaurant.service.js), so the two can never disagree — including only
// counting restaurants that are actually live (approved and active), which this endpoint
// used to skip.
//
// Two counts, because the app now has two things to say. `restaurantCount` is the strict one
// (restaurants that will deliver to this pin) and still drives `serviceable`. `browsableCount`
// is everything visible within the platform's discovery radius, which is what the customer
// will actually see listed — so the address screen can distinguish "there is nothing out
// here" from "plenty nearby, but none of them reach this far yet", two situations that used
// to produce the identical, unhelpful "we don't deliver here".
export const serviceability = asyncHandler(async (req, res) => {
  const at = parseCoordParam(req.query.at);
  if (!at) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid `at=lng,lat` is required');

  const { restaurantCount, discoverableCount, nearestKm, nearestDiscoverableKm } =
    await checkServiceability(at[1], at[0]);

  sendSuccess(res, 200, 'Serviceability checked', {
    serviceable: restaurantCount > 0,
    restaurantCount,
    nearestKm,
    browsableCount: discoverableCount,
    nearestBrowsableKm: nearestDiscoverableKm,
  });
});
