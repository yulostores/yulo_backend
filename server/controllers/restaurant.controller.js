import Restaurant from '../models/Restaurant.js';
import Review from '../models/Review.js';
import MenuItem from '../models/MenuItem.js';
import * as menuService from '../services/menu.service.js';
import * as cacheService from '../services/cache.service.js';
import * as favoriteService from '../services/favorite.service.js';
import * as searchService from '../services/search.service.js';
import * as restaurantService from '../services/restaurant.service.js';
import { escapeRegExp } from '../utils/regex.js';
import { PUBLIC_RESTAURANT_FILTER, PUBLIC_RESTAURANT_PROJECTION } from '../utils/publicRestaurant.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const PAGE_SIZE = 20;

const getFavoritedRestaurantIds = (req) =>
  req.user ? favoriteService.getFavoritedIdSet(req.user._id, 'restaurant') : null;

const attachStartingPrices = async (restaurants) => {
  const startingPrices = await menuService.getStartingPrices(restaurants.map((r) => r._id));
  for (const r of restaurants) r.startingPrice = startingPrices.get(String(r._id)) ?? null;
};

export const listRestaurants = asyncHandler(async (req, res) => {
  const { lat, lng, radius = 5, page = 1, q, minRating, hasOffers, vegOnly } = req.query;
  const favoritedIds = await getFavoritedRestaurantIds(req);
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);

  const extraFilter = {};
  if (minRating) extraFilter.avgRating = { $gte: parseFloat(minRating) };
  if (vegOnly === 'true') extraFilter.isPureVeg = true;
  if (hasOffers === 'true') {
    extraFilter._id = { $in: await searchService.getRestaurantIdsWithActiveOffers() };
  }
  const hasExtraFilters = Boolean(minRating || vegOnly === 'true' || hasOffers === 'true');

  // Geo-browse (no `q`) sorts+filters via $near; a text/filter search doesn't need a
  // location at all. The two are mutually exclusive below because MongoDB doesn't allow
  // $near inside the $match an aggregation-based count uses — see the `useGeoNear` branch.
  const useGeoNear = !q;

  // Only the plain geo-browse (no q, no extra filters) is cacheable — search/filter
  // combinations are far less repeatable and would need a combinatorial cache key.
  const isCacheable = useGeoNear && !hasExtraFilters;
  const cacheKey = isCacheable
    ? `cache:restaurants:${parseFloat(lat)}:${parseFloat(lng)}:${radius}:${parsedPage}`
    : null;

  if (cacheKey) {
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      // `cached` is a fresh object from JSON.parse (see cache.service.js) — mutating it
      // here only affects this response, never what's stored in Redis for the next requester.
      favoriteService.annotateRestaurants(cached.restaurants, favoritedIds);
      return sendSuccess(res, 200, 'Nearby restaurants', cached);
    }
  }

  let data;
  if (useGeoNear) {
    if (!lat || !lng) throw new ApiError(400, 'VALIDATION_ERROR', 'lat and lng are required');

    // total/pages intentionally omitted: MongoDB only allows $geoWithin/$geoIntersects
    // inside an aggregation $match (which is what countDocuments() uses under the hood) —
    // not $near/$nearSphere. The pre-Prompt-7 version of this endpoint never computed
    // total/pages for the geo-browse case either, for the same reason.
    // restaurantService.findNearby is the same $near query the home feed's
    // nearbyRestaurants reuses — see services/restaurant.service.js.
    const restaurants = await restaurantService.findNearby(lat, lng, radius, {
      page: parsedPage,
      limit: PAGE_SIZE,
      extraFilter,
    });
    await attachStartingPrices(restaurants);
    data = { restaurants, page: parsedPage };
  } else {
    const regex = new RegExp(escapeRegExp(q.trim()), 'i');

    // A customer typing into the Search tab expects dish names to count, not just
    // restaurant names and cuisines — the field itself prompts "restaurants and
    // dishes". Resolve the restaurants that currently serve a matching, available
    // item and fold them into the $or as a third branch. Same unanchored,
    // case-insensitive name regex the typeahead's global dish lookup uses
    // (search.service.js#typeahead); PUBLIC_RESTAURANT_FILTER above still gates
    // the result, so an item on a suspended/unapproved store surfaces nothing.
    const menuMatchIds = await MenuItem.distinct('restaurantId', {
      name: regex,
      isAvailable: true,
    });

    const filter = {
      ...PUBLIC_RESTAURANT_FILTER,
      ...extraFilter,
      $or: [
        { name: regex },
        { cuisineTypes: regex },
        ...(menuMatchIds.length > 0 ? [{ _id: { $in: menuMatchIds } }] : []),
      ],
    };

    const [restaurants, total] = await Promise.all([
      Restaurant.find(filter)
        .select(PUBLIC_RESTAURANT_PROJECTION)
        .skip((parsedPage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean(),
      Restaurant.countDocuments(filter),
    ]);
    await attachStartingPrices(restaurants);
    data = { restaurants, total, page: parsedPage, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  }

  // Cache BEFORE annotating isFavorited: startingPrice is fine to share (not
  // user-specific), but isFavorited must never be baked into the shared 60s cache entry —
  // the next request for this same lat/lng/radius/page could be a different (or
  // anonymous) user.
  if (cacheKey) await cacheService.set(cacheKey, data, 60);
  favoriteService.annotateRestaurants(data.restaurants, favoritedIds);
  sendSuccess(res, 200, q ? 'Search results' : 'Nearby restaurants', data);
});

export const getRestaurant = asyncHandler(async (req, res) => {
  // Already loaded (and approval-checked) by loadPublicRestaurant on the route.
  const restaurant = req.publicRestaurant;

  const favoritedIds = await getFavoritedRestaurantIds(req);
  favoriteService.annotateRestaurants(restaurant, favoritedIds);

  sendSuccess(res, 200, 'Restaurant detail', { restaurant });
});

export const getMenu = asyncHandler(async (req, res) => {
  const menu = await menuService.getMenu(req.params.id);

  // Same cache-then-annotate ordering as listRestaurants above — menuService.getMenu()
  // has already completed its own 5-min cache.set() by the time it returns to us, so
  // annotating the returned object here never leaks into what's cached.
  const favoritedIds = req.user
    ? await favoriteService.getFavoritedIdSet(req.user._id, 'menu_item')
    : null;
  favoriteService.annotateMenuFavorites(menu, favoritedIds);

  sendSuccess(res, 200, 'Menu', { menu });
});

// Paginated, lazy-load feed for the storefront menu (customer app screen 14).
// getMenu() above returns the WHOLE menu tree in one 5-min-cached payload — fine for the
// owner portal, too much for a phone opening a restaurant. This serves one category (or the
// whole menu) a page at a time so the app fetches item detail only for sections the customer
// actually expands or scrolls to. Indexed by { restaurantId, categoryId } / { restaurantId,
// isAvailable } on MenuItem — deliberately not Redis-cached, since the page/category/foodType
// combinations aren't repeatable enough to key (same call as getReviews below).
const MENU_ITEMS_PAGE_SIZE = 10;
const MENU_ITEMS_MAX_PAGE_SIZE = 30;
const FOOD_TYPES = ['veg', 'non_veg', 'egg'];

export const listMenuItems = asyncHandler(async (req, res) => {
  const { categoryId, subCategoryId, foodType, page = 1, limit } = req.query;
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(
    MENU_ITEMS_MAX_PAGE_SIZE,
    Math.max(1, parseInt(limit, 10) || MENU_ITEMS_PAGE_SIZE)
  );

  const filter = { restaurantId: req.params.id, isAvailable: true };
  if (categoryId) filter.categoryId = categoryId;
  if (subCategoryId) filter.subCategoryId = subCategoryId;
  if (FOOD_TYPES.includes(foodType)) filter.foodType = foodType;

  const [items, total] = await Promise.all([
    MenuItem.find(filter)
      .sort({ createdAt: 1 })
      .skip((parsedPage - 1) * parsedLimit)
      .limit(parsedLimit)
      .lean({ virtuals: true }),
    MenuItem.countDocuments(filter),
  ]);

  const favoritedIds = req.user
    ? await favoriteService.getFavoritedIdSet(req.user._id, 'menu_item')
    : null;
  favoriteService.annotateEntity(items, favoritedIds);
  await menuService.attachOptionGroupCounts(items);

  sendSuccess(res, 200, 'Menu items', {
    items,
    total,
    page: parsedPage,
    pages: Math.max(1, Math.ceil(total / parsedLimit)),
  });
});

export const searchRestaurantMenu = asyncHandler(async (req, res) => {
  const { q, foodType } = req.query;
  if (!q || !q.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'q is required');

  const items = await menuService.searchMenu(req.params.id, q, foodType);

  const favoritedIds = req.user
    ? await favoriteService.getFavoritedIdSet(req.user._id, 'menu_item')
    : null;
  favoriteService.annotateEntity(items, favoritedIds);
  await menuService.attachOptionGroupCounts(items);

  sendSuccess(res, 200, 'Menu search results', { items });
});

export const getMenuCategories = asyncHandler(async (req, res) => {
  const categories = await menuService.getMenuCategories(req.params.id);
  sendSuccess(res, 200, 'Menu categories', { categories });
});

export const getReviews = asyncHandler(async (req, res) => {
  const { page = 1 } = req.query;
  const parsedPage = Math.max(1, parseInt(page, 10));

  const [reviews, total] = await Promise.all([
    Review.find({ restaurantId: req.params.id })
      .sort({ createdAt: -1 })
      .skip((parsedPage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate('userId', 'name profilePicture')
      .lean(),
    Review.countDocuments({ restaurantId: req.params.id }),
  ]);

  sendSuccess(res, 200, 'Reviews', { reviews, total, page: parsedPage });
});
