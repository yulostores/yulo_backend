import Restaurant from '../models/Restaurant.js';
import { PUBLIC_RESTAURANT_FILTER, PUBLIC_RESTAURANT_PROJECTION } from '../utils/publicRestaurant.js';

const DEFAULT_PAGE_SIZE = 20;

// Shared by GET /api/restaurants' geo-browse path (controllers/restaurant.controller.js)
// and the home feed's nearbyRestaurants (services/home.service.js) — one $near query,
// not duplicated logic. `extraFilter` lets callers layer on conditions (e.g. isPureVeg,
// avgRating, an offers `_id` $in) without this function knowing about any of that itself.
export const findNearby = async (
  lat,
  lng,
  radiusKm,
  { page = 1, limit = DEFAULT_PAGE_SIZE, extraFilter = {} } = {}
) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);

  return Restaurant.find({
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
        $maxDistance: parseFloat(radiusKm) * 1000,
      },
    },
    ...PUBLIC_RESTAURANT_FILTER,
    ...extraFilter,
  })
    .select(PUBLIC_RESTAURANT_PROJECTION)
    .skip((parsedPage - 1) * limit)
    .limit(limit)
    .lean();
};
