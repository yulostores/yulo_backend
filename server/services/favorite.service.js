import Favorite from '../models/Favorite.js';
import Restaurant from '../models/Restaurant.js';
import MenuItem from '../models/MenuItem.js';
import { ApiError } from '../utils/ApiError.js';
import { PUBLIC_RESTAURANT_FILTER } from '../utils/publicRestaurant.js';

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// One query per request for the caller's full favorited-ID set of a given type — every
// annotate* helper below reads from this Set, so listing N restaurants/items costs one
// extra query total, not N.
export const getFavoritedIdSet = async (userId, entityType) => {
  if (!userId) return null;
  const favorites = await Favorite.find({ userId, entityType }).select('entityId').lean();
  return new Set(favorites.map((f) => String(f.entityId)));
};

// `favoritedIds === null` means "anonymous request" — isFavorited is left OMITTED (not
// set to false) so it never gets baked into a shared/cached payload as a false-for-everyone
// value. Mutates in place; callers control whether that's safe (see restaurant.controller.js
// for why this always runs on data already past the cache.set() call, never before it).
const annotateWithFavorited = (docOrDocs, favoritedIds) => {
  if (!favoritedIds) return docOrDocs;
  const list = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
  for (const doc of list) doc.isFavorited = favoritedIds.has(String(doc._id));
  return docOrDocs;
};

export const annotateRestaurants = (restaurants, favoritedIds) =>
  annotateWithFavorited(restaurants, favoritedIds);

// Generic single-doc/array annotator for anything else keyed by `_id` — e.g. the
// standalone GET /api/items/:id item-detail response, which isn't part of a grouped
// menu payload so annotateMenuFavorites below doesn't apply to it.
export const annotateEntity = (docOrDocs, favoritedIds) =>
  annotateWithFavorited(docOrDocs, favoritedIds);

// Menu payloads are grouped: category.items (no subcategory) and
// category.subCategories[].items — both branches need annotating.
export const annotateMenuFavorites = (menu, favoritedIds) => {
  if (!favoritedIds) return menu;
  for (const category of menu) {
    for (const item of category.items || []) item.isFavorited = favoritedIds.has(String(item._id));
    for (const sub of category.subCategories || []) {
      for (const item of sub.items || []) item.isFavorited = favoritedIds.has(String(item._id));
    }
  }
  return menu;
};

export const addRestaurantFavorite = async (userId, restaurantId) => {
  const exists = await Restaurant.exists({ _id: restaurantId, ...PUBLIC_RESTAURANT_FILTER });
  if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  // Upsert, not insert — favoriting an already-favorited restaurant is a no-op success,
  // not a 409, matching how a heart-icon toggle is expected to behave from the client.
  await Favorite.findOneAndUpdate(
    { userId, entityType: 'restaurant', entityId: restaurantId },
    {},
    { upsert: true, setDefaultsOnInsert: true }
  );
};

export const removeRestaurantFavorite = (userId, restaurantId) =>
  Favorite.deleteOne({ userId, entityType: 'restaurant', entityId: restaurantId });

export const addItemFavorite = async (userId, menuItemId) => {
  const exists = await MenuItem.exists({ _id: menuItemId });
  if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');

  await Favorite.findOneAndUpdate(
    { userId, entityType: 'menu_item', entityId: menuItemId },
    {},
    { upsert: true, setDefaultsOnInsert: true }
  );
};

export const removeItemFavorite = (userId, menuItemId) =>
  Favorite.deleteOne({ userId, entityType: 'menu_item', entityId: menuItemId });

export const listFavoriteRestaurants = async (userId, page = 1, limit = PAGE_SIZE) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || PAGE_SIZE));

  const [favorites, total] = await Promise.all([
    Favorite.find({ userId, entityType: 'restaurant' })
      .sort({ createdAt: -1 })
      .skip((parsedPage - 1) * parsedLimit)
      .limit(parsedLimit)
      .lean(),
    Favorite.countDocuments({ userId, entityType: 'restaurant' }),
  ]);

  const restaurantIds = favorites.map((f) => f.entityId);
  const restaurants = await Restaurant.find({
    _id: { $in: restaurantIds },
    ...PUBLIC_RESTAURANT_FILTER,
  }).lean();

  // `$in` doesn't preserve order — re-sort to most-recently-favorited-first, and drop any
  // favorite whose restaurant was deactivated/deleted since (rather than erroring).
  const byId = new Map(restaurants.map((r) => [String(r._id), r]));
  const ordered = favorites.map((f) => byId.get(String(f.entityId))).filter(Boolean);
  for (const r of ordered) r.isFavorited = true;

  return {
    restaurants: ordered,
    total,
    page: parsedPage,
    pages: Math.max(1, Math.ceil(total / parsedLimit)),
  };
};
