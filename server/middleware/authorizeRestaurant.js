import Restaurant from '../models/Restaurant.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authorizeRestaurant = asyncHandler(async (req, res, next) => {
  const restaurant = await Restaurant.findOne({
    _id: req.params.restaurantId,
    ownerId: req.user._id,
  });
  if (!restaurant) {
    throw new ApiError(403, 'NOT_OWNER', 'You do not own this restaurant');
  }
  req.restaurant = restaurant;
  next();
});
