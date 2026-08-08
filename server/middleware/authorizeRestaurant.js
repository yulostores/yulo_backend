import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authorizeRestaurant = asyncHandler(async (req, res, next) => {
  const { restaurantId } = req.params;

  if (!restaurantId || !mongoose.Types.ObjectId.isValid(restaurantId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid restaurant ID format');
  }

  const restaurant = await Restaurant.findOne({
    _id: new mongoose.Types.ObjectId(restaurantId),
    ownerId: req.user._id,
  });

  if (!restaurant) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not own this restaurant');
  }

  req.restaurant = restaurant;
  next();
});
