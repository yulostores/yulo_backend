import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import {
  DELIVERS_TO_PIN_EXPR,
  DISCOVERY_RADIUS_KM,
  EFFECTIVE_RADIUS_KM_EXPR,
} from '../config/delivery.config.js';
import {
  PUBLIC_RESTAURANT_FILTER,
  PUBLIC_RESTAURANT_HIDDEN_FIELDS,
} from '../utils/publicRestaurant.js';
import { ApiError } from '../utils/ApiError.js';

const DEFAULT_PAGE_SIZE = 20;

const roundKm = (meters) => Math.round(meters / 100) / 10;

// `lat`/`lng` arrive as query strings. Left unchecked, a missing or non-numeric one reaches
// $geoNear as NaN and surfaces as a 500 from Mongo instead of a 400 the app can act on.
const parsePoint = (lat, lng) => {
  const point = [parseFloat(lng), parseFloat(lat)];
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'lat and lng must be valid coordinates');
  }
  return point;
};

// Aggregation stages don't get Mongoose's query casting, and callers hand us `_id: { $in }`
// lists of strings (the offers filter) — cast them or the stage silently matches nothing.
const castFilter = (filter) => {
  const ids = filter._id?.$in;
  if (!ids) return filter;
  return { ...filter, _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) } };
};

// DISCOVERY: every live restaurant within the platform browse radius of the pin, nearest
// first. One stage, because that is now the whole rule — no per-restaurant radius $match.
//
// This is the stage that changed. It used to also drop any candidate the customer was
// outside the delivery radius OF, which meant a restaurant that had never filled in the
// delivery form (radius defaulted to 5 km) was missing from the app for everyone further
// away, with no way for the owner or an admin to see that was happening. Reach is now
// reported per row (`deliversToPin`) instead of deciding whether the row exists.
//
// Exported for the contract test that pins the rule.
export const discoveryStages = (point, extraFilter = {}) => [
  {
    $geoNear: {
      near: { type: 'Point', coordinates: point },
      distanceField: 'distanceMeters',
      spherical: true,
      maxDistance: DISCOVERY_RADIUS_KM * 1000,
      query: { ...PUBLIC_RESTAURANT_FILTER, ...castFilter(extraFilter) },
    },
  },
];

// DELIVERY: the narrower "can this restaurant actually bring food here" rule — discovery,
// plus each restaurant's own zone. Used by /api/geo/serviceability, which answers "will
// anything deliver to this address?" and must not count a restaurant the customer can see
// but cannot order from.
export const serviceableStages = (point, extraFilter = {}) => [
  ...discoveryStages(point, extraFilter),
  {
    $match: {
      $expr: { $lte: ['$distanceMeters', { $multiply: [EFFECTIVE_RADIUS_KM_EXPR, 1000] }] },
    },
  },
];

// Restaurants near (lat, lng), nearest first. Shared by GET /api/restaurants' geo-browse
// path (controllers/restaurant.controller.js) and the home feed's nearbyRestaurants
// (services/home.service.js) — one query, not duplicated logic. `extraFilter` lets callers
// layer on conditions (isPureVeg, avgRating, an offers `_id` $in) without this function
// knowing about any of that itself.
//
// Scope is the platform's DISCOVERY_RADIUS_KM, never a radius the client sends: the app
// used to pass a flat 5 km, which hid every store whose zone reached further.
//
// Each row carries:
//   distanceKm    straight-line, one decimal — the same figure the sort used, so a client
//                 never has to recompute it and land on a different number.
//   deliversToPin whether THIS restaurant's own zone covers the pin. False means "listed,
//                 but too far to order from" — a state the card is expected to render,
//                 not one it should filter out silently.
export const findNearby = async (
  lat,
  lng,
  { page = 1, limit = DEFAULT_PAGE_SIZE, extraFilter = {} } = {}
) => {
  const point = parsePoint(lat, lng);
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);

  // One row past the page tells us whether another page exists. The count that would say so
  // directly isn't available: $geoNear has to be the first stage, and a second aggregation
  // just to count would repeat the whole scan.
  //
  // $geoNear already emits in increasing distance order and $skip/$limit preserve it, so the
  // "sorted by increasing distance" guarantee needs no $sort stage — but it is also the
  // guarantee most easily lost by a later edit, so nearby.contract.test.js pins it.
  const rows = await Restaurant.aggregate([
    ...discoveryStages(point, extraFilter),
    { $skip: (parsedPage - 1) * limit },
    { $limit: limit + 1 },
    {
      $set: {
        distanceKm: { $round: [{ $divide: ['$distanceMeters', 1000] }, 1] },
        deliversToPin: DELIVERS_TO_PIN_EXPR,
      },
    },
    { $unset: ['distanceMeters', ...PUBLIC_RESTAURANT_HIDDEN_FIELDS] },
  ]);

  const hasMore = rows.length > limit;
  return { restaurants: hasMore ? rows.slice(0, limit) : rows, hasMore };
};

// "Will anything deliver here?" for /api/geo/serviceability — how many restaurants cover the
// pin and how far the closest one is. Counted inside Mongo rather than by fetching documents.
//
// `restaurantCount` deliberately uses the DELIVERY rule, not discovery: this endpoint is what
// the address flow shows before a customer commits to an address, so it must mean "can order
// from", not "can see". `discoverableCount` reports the wider set so the app can distinguish
// "nothing here at all" from "restaurants nearby, none of them delivering this far yet".
export const checkServiceability = async (lat, lng) => {
  const point = parsePoint(lat, lng);
  const [summary] = await Restaurant.aggregate([
    ...discoveryStages(point),
    {
      $group: {
        _id: null,
        discoverableCount: { $sum: 1 },
        nearestMeters: { $min: '$distanceMeters' },
        deliverableCount: { $sum: { $cond: [DELIVERS_TO_PIN_EXPR, 1, 0] } },
        nearestDeliverableMeters: {
          $min: { $cond: [DELIVERS_TO_PIN_EXPR, '$distanceMeters', null] },
        },
      },
    },
  ]);

  return {
    restaurantCount: summary?.deliverableCount ?? 0,
    discoverableCount: summary?.discoverableCount ?? 0,
    nearestKm: summary?.nearestDeliverableMeters != null
      ? roundKm(summary.nearestDeliverableMeters)
      : null,
    nearestDiscoverableKm: summary ? roundKm(summary.nearestMeters) : null,
  };
};
