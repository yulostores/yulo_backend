import { ApiError } from '../utils/ApiError.js';

// Mounted after authorizeRestaurant, which already loaded req.restaurant.
export const requireRestaurantApproved = (req, res, next) => {
  if (req.restaurant.approvalStatus !== 'active') {
    throw new ApiError(
      403,
      'RESTAURANT_NOT_APPROVED',
      'This restaurant is not yet approved by admin — staff and menu management are locked until approval'
    );
  }
  next();
};
