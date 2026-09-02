import Restaurant from '../models/Restaurant.js';
import { PUBLIC_RESTAURANT_FILTER } from '../utils/publicRestaurant.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Mounted on every /api/restaurants/:id/* route. Those handlers read menus, categories
// and reviews straight out of their own collections by restaurantId and never load the
// Restaurant itself, so without this there was nothing anywhere in the request that could
// notice the restaurant was unapproved or suspended — the menu of a store no customer is
// supposed to see was served as normal.
//
// 404 rather than 403: to a customer an unapproved store simply doesn't exist, and saying
// otherwise would leak that a specific id is a real restaurant awaiting review.
export const loadPublicRestaurant = asyncHandler(async (req, res, next) => {
  const restaurant = await Restaurant.findOne({
    _id: req.params.id,
    ...PUBLIC_RESTAURANT_FILTER,
  }).lean();

  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  // getRestaurant reuses this instead of querying the same document a second time.
  req.publicRestaurant = restaurant;
  next();
});
