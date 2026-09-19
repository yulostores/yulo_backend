import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import {
  EFFECTIVE_RADIUS_KM_EXPR,
  MAX_DELIVERY_RADIUS_KM,
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

// The two stages that define "delivers to this pin", shared by every reader so the definition
// can't drift between screens:
//
//   1. $geoNear pulls candidates in distance order, out to the platform ceiling only — the
//      cheapest bound that can't hide anyone, since no store's zone extends past it.
//   2. $match keeps a candidate only if the customer is inside THAT restaurant's own radius.
//
// Exported for the contract test that pins the rule.
export const serviceableStages = (point, extraFilter = {}) => [
  {
    $geoNear: {
      near: { type: 'Point', coordinates: point },
      distanceField: 'distanceMeters',
      spherical: true,
      maxDistance: MAX_DELIVERY_RADIUS_KM * 1000,
      query: { ...PUBLIC_RESTAURANT_FILTER, ...castFilter(extraFilter) },
    },
  },
  {
    $match: {
      $expr: { $lte: ['$distanceMeters', { $multiply: [EFFECTIVE_RADIUS_KM_EXPR, 1000] }] },
    },
  },
];

// Restaurants that deliver to (lat, lng), nearest first. Shared by GET /api/restaurants'
// geo-browse path (controllers/restaurant.controller.js) and the home feed's
// nearbyRestaurants (services/home.service.js) — one query, not duplicated logic.
// `extraFilter` lets callers layer on conditions (e.g. isPureVeg, avgRating, an offers `_id`
// $in) without this function knowing about any of that itself.
//
// Serviceability is decided by each restaurant's own delivery radius (capped by the
// platform — see config/delivery.config.js), never by a radius the client sends: the app
// used to pass a flat 5 km, which hid every store whose zone reached further and showed
// ones that don't actually deliver that far.
//
// Each row carries `distanceKm` (straight-line, one decimal) so clients show the same figure
// the zone check used instead of recomputing it.
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
  const rows = await Restaurant.aggregate([
    ...serviceableStages(point, extraFilter),
    { $skip: (parsedPage - 1) * limit },
    { $limit: limit + 1 },
    { $set: { distanceKm: { $round: [{ $divide: ['$distanceMeters', 1000] }, 1] } } },
    { $unset: ['distanceMeters', ...PUBLIC_RESTAURANT_HIDDEN_FIELDS] },
  ]);

  const hasMore = rows.length > limit;
  return { restaurants: hasMore ? rows.slice(0, limit) : rows, hasMore };
};

// "Will anything deliver here?" for /api/geo/serviceability — how many restaurants cover the
// pin and how far the closest one is. Counted inside Mongo rather than by fetching documents.
export const checkServiceability = async (lat, lng) => {
  const point = parsePoint(lat, lng);
  const [summary] = await Restaurant.aggregate([
    ...serviceableStages(point),
    { $group: { _id: null, count: { $sum: 1 }, nearestMeters: { $min: '$distanceMeters' } } },
  ]);

  return {
    restaurantCount: summary?.count ?? 0,
    nearestKm: summary ? roundKm(summary.nearestMeters) : null,
  };
};
