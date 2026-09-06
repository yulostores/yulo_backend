import Restaurant from '../models/Restaurant.js';
import { PUBLIC_RESTAURANT_FILTER } from '../utils/publicRestaurant.js';
import MenuItem from '../models/MenuItem.js';
import Discount from '../models/Discount.js';
import SearchHistory from '../models/SearchHistory.js';
import QuickFilterChip from '../models/QuickFilterChip.js';
import * as cacheService from './cache.service.js';
import logger from '../utils/logger.js';
import { escapeRegExp } from '../utils/regex.js';

const TYPEAHEAD_LIMIT_PER_SOURCE = 6;
const RECENT_SEARCH_CAP = 20;
const POPULAR_WINDOW_DAYS = 7;
const POPULAR_LIMIT = 9;

// Curated fallback only — used until there's 7 days of real SearchHistory to aggregate.
// The "Chicken" -> "Paneer" swap mirrors the one Figma shows between the standard and
// veg-mode "Popular right now" grids; everything else in both lists is diet-neutral.
const POPULAR_SEED_STANDARD = [
  'Biryani', 'Chicken', 'North Indian', 'Veg meal', 'Pizza', 'Sandwich', 'Paneer', 'Dosa', 'Noodles',
];
const POPULAR_SEED_VEG = [
  'Biryani', 'Paneer', 'North Indian', 'Veg meal', 'Pizza', 'Sandwich', 'Dosa', 'Noodles',
];

// Merges two independent sources — restaurant name matches and a global dish-name match
// across every restaurant's menu (not just one) — capped per source before merging, not
// a single combined query, since they're different collections with different shapes.
export const typeahead = async (q) => {
  const regex = new RegExp(escapeRegExp(q.trim()), 'i');

  const [restaurants, items] = await Promise.all([
    Restaurant.find({ name: regex, ...PUBLIC_RESTAURANT_FILTER })
      .select('name logo')
      .limit(TYPEAHEAD_LIMIT_PER_SOURCE)
      .lean(),
    MenuItem.find({ name: regex, isAvailable: true })
      .select('name image foodType')
      .limit(TYPEAHEAD_LIMIT_PER_SOURCE)
      .lean(),
  ]);

  // Deliberately NOT veg-filtered here — a non-veg dish still surfaces in typeahead even
  // with veg mode on (the client renders `foodType` as a veg/non-veg indicator dot rather
  // than hiding the row); veg mode only filters/substitutes content on the results-listing
  // and home-feed surfaces, not this raw dish-name lookup.
  return [
    ...restaurants.map((r) => ({
      id: r._id,
      name: r.name,
      type: 'restaurant',
      thumbnailUrl: r.logo ?? null,
      foodType: null,
    })),
    ...items.map((i) => ({
      id: i._id,
      name: i.name,
      type: 'dish',
      thumbnailUrl: i.image ?? null,
      foodType: i.foodType,
    })),
  ];
};

// Dedupes by exact query text (case-sensitive, trimmed) so re-searching something already
// in the list moves it to the top instead of appearing twice, then trims back down to the
// cap — two extra queries per write, acceptable at a 20-item ceiling.
export const recordSearch = async (userId, query) => {
  const trimmed = query.trim();
  if (!trimmed) return;

  await SearchHistory.deleteMany({ userId, query: trimmed });
  await SearchHistory.create({ userId, query: trimmed });

  const excess = await SearchHistory.find({ userId })
    .sort({ createdAt: -1 })
    .skip(RECENT_SEARCH_CAP)
    .select('_id')
    .lean();
  if (excess.length > 0) {
    await SearchHistory.deleteMany({ _id: { $in: excess.map((e) => e._id) } });
  }
};

export const listRecentSearches = (userId) =>
  SearchHistory.find({ userId }).sort({ createdAt: -1 }).limit(RECENT_SEARCH_CAP).lean();

export const removeRecentSearch = (userId, id) => SearchHistory.deleteOne({ _id: id, userId });

// How long the enriched "Popular right now" list is cached. The image lookups below are
// the expensive part; the list of terms itself barely moves inside a 10-minute window.
const POPULAR_CACHE_TTL_SECONDS = 10 * 60;

const anchoredRegex = (term) => new RegExp(`^${escapeRegExp(term.trim())}$`, 'i');
const containsRegex = (term) => new RegExp(escapeRegExp(term.trim()), 'i');

// Resolve one representative image URL for a popular term so the customer app's "Popular
// right now" grid can render like the design without the app shipping any artwork of its
// own. Preference order: a curated quick-filter icon (purpose-built for exactly this row)
// → a real dish photo whose name matches → a restaurant image for that cuisine → null,
// which the app draws as a placeholder tile.
//
// Best-effort by design: any lookup that throws (or a term that matches nothing) yields
// null for that one tile and is logged, never bubbled — one broken row must not blank the
// whole grid or 500 the endpoint.
const resolvePopularImage = async (term, vegOnly) => {
  try {
    const exact = anchoredRegex(term);
    const chip = await QuickFilterChip.findOne({
      isActive: true,
      $or: [{ queryParam: exact }, { label: exact }],
    })
      .select('iconUrl veg')
      .lean();
    if (chip) {
      const icon = (vegOnly && chip.veg?.iconUrl) || chip.iconUrl;
      if (icon) return icon;
    }

    const partial = containsRegex(term);
    const dish = await MenuItem.findOne({
      name: partial,
      isAvailable: true,
      image: { $type: 'string', $ne: '' },
    })
      .select('image')
      .sort({ updatedAt: -1 })
      .lean();
    if (dish?.image) return dish.image;

    const restaurant = await Restaurant.findOne({
      cuisineTypes: partial,
      ...PUBLIC_RESTAURANT_FILTER,
    })
      .select('bannerImage logo coverImage')
      .lean();
    const restaurantImage =
      restaurant?.bannerImage || restaurant?.logo || restaurant?.coverImage;
    if (restaurantImage) return restaurantImage;

    return null;
  } catch (err) {
    logger.warn({ err, term }, 'Popular search image resolution failed');
    return null;
  }
};

// Real aggregation once there's data; falls back to the curated seed lists otherwise.
// The frequency-based branch is intentionally NOT veg-filtered — these are arbitrary past
// free-text queries ("biryani near me"), and there's no reliable way to classify one as
// veg/non-veg without NLP this codebase doesn't have; only the hardcoded fallback differs
// by `vegOnly`. Every returned term carries an `imageUrl` (possibly null) — see
// {@link resolvePopularImage}.
export const getPopularSearches = async (vegOnly) => {
  const cacheKey = `cache:search:popular:${vegOnly ? 'veg' : 'std'}`;
  const cached = await cacheService.get(cacheKey);
  if (cached) return cached;

  const since = new Date(Date.now() - POPULAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const results = await SearchHistory.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$query', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: POPULAR_LIMIT },
  ]);

  const terms =
    results.length === 0
      ? vegOnly
        ? POPULAR_SEED_VEG
        : POPULAR_SEED_STANDARD
      : results.map((r) => r._id);

  const popular = await Promise.all(
    terms.map(async (query) => ({
      query,
      imageUrl: await resolvePopularImage(query, vegOnly),
    })),
  );

  await cacheService.set(cacheKey, popular, POPULAR_CACHE_TTL_SECONDS);
  return popular;
};

// Backs the `hasOffers` restaurant-search filter — "active" also means within the
// discount's own date range right now, not just `status: 'active'` (a discount's status
// doesn't auto-expire; see billing.service.js's DISCOUNT_EXPIRED check at redemption time
// for the same distinction).
export const getRestaurantIdsWithActiveOffers = async () => {
  const now = new Date();
  const discounts = await Discount.find({
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
    .select('restaurantId')
    .lean();
  return [...new Set(discounts.map((d) => String(d.restaurantId)))];
};
