import * as homeService from '../services/home.service.js';
import * as favoriteService from '../services/favorite.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getFeed = asyncHandler(async (req, res) => {
  // A `radius` param is deliberately not read: builds in the field still send `radius=5`,
  // and honouring it would keep them on a flat 5 km circle. The browse radius is the
  // platform's DISCOVERY_RADIUS_KM; per-restaurant zones only decide `deliversToPin`.
  const { lat, lng, vegMode, vegScope } = req.query;
  if (!lat || !lng) throw new ApiError(400, 'VALIDATION_ERROR', 'lat and lng are required');

  const parsedVegMode = vegMode === 'true';
  const parsedVegScope = vegScope === 'pure_veg_only' ? 'pure_veg_only' : 'all_restaurants';

  const feed = await homeService.getHomeFeed({
    lat,
    lng,
    vegMode: parsedVegMode,
    vegScope: parsedVegScope,
  });

  if (req.user) {
    const [favoritedRestaurantIds, favoritedItemIds] = await Promise.all([
      favoriteService.getFavoritedIdSet(req.user._id, 'restaurant'),
      favoriteService.getFavoritedIdSet(req.user._id, 'menu_item'),
    ]);
    // nearbyRestaurants and recommendedRestaurants share the same underlying restaurant
    // objects (see home.service.js) — annotating one annotates both.
    favoriteService.annotateRestaurants(feed.nearbyRestaurants, favoritedRestaurantIds);
    favoriteService.annotateEntity(feed.recommendedItems, favoritedItemIds);
  }

  sendSuccess(res, 200, 'Home feed', feed);
});
