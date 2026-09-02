import Restaurant from '../models/Restaurant.js';
import * as cacheService from '../services/cache.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PUBLIC_RESTAURANT_FILTER } from '../utils/publicRestaurant.js';

const CACHE_KEY = 'cache:cuisines';
// Short enough that a cuisine a new restaurant introduces starts being suggested the
// same session, long enough that the aggregation runs rarely.
const CACHE_TTL_SECONDS = 15 * 60;

// There is no Cuisine collection: `Restaurant.cuisineTypes` is a free-form `[String]`,
// which is what lets an owner describe a kitchen the platform hasn't seen before. So the
// vocabulary is derived from the restaurants that actually use it rather than kept in a
// list somewhere that would need maintaining — and it stays correct on its own as the
// platform grows.
//
// The one thing free-form text can't do by itself is stay spelled consistently, which is
// what the counts are for: entries are folded case-insensitively, and each one reports
// the spelling most restaurants actually use, so a client can offer that back and stop
// "north indian" and "North Indian" becoming two cuisines.
const aggregateCuisines = () =>
  Restaurant.aggregate([
    // Same visibility rule the public restaurant endpoints use.
    { $match: { ...PUBLIC_RESTAURANT_FILTER } },
    { $unwind: '$cuisineTypes' },
    { $set: { cuisine: { $trim: { input: '$cuisineTypes' } } } },
    { $match: { cuisine: { $ne: '' } } },
    // Count each distinct spelling first…
    { $group: { _id: { folded: { $toLower: '$cuisine' }, spelling: '$cuisine' }, count: { $sum: 1 } } },
    { $sort: { count: -1, '_id.spelling': 1 } },
    // …then fold them together, so `$first` is the most-used spelling rather than
    // whichever document the pipeline happened to reach first.
    {
      $group: {
        _id: '$_id.folded',
        name: { $first: '$_id.spelling' },
        restaurantCount: { $sum: '$count' },
      },
    },
    { $sort: { restaurantCount: -1, _id: 1 } },
    { $project: { _id: 0, name: 1, restaurantCount: 1 } },
  ]);

export const listCuisines = asyncHandler(async (req, res) => {
  const cached = await cacheService.get(CACHE_KEY);
  if (cached) return sendSuccess(res, 200, 'Cuisines', { cuisines: cached });

  const cuisines = await aggregateCuisines();
  await cacheService.set(CACHE_KEY, cuisines, CACHE_TTL_SECONDS);
  sendSuccess(res, 200, 'Cuisines', { cuisines });
});
