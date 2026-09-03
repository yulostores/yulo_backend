import MenuItem from '../models/MenuItem.js';
import Discount from '../models/Discount.js';
import * as restaurantService from './restaurant.service.js';
import * as menuService from './menu.service.js';

const NEARBY_LIMIT = 20;
const RECOMMENDED_ITEMS_LIMIT = 10;

// No CMS — a hardcoded config array the owner/admin can't edit yet (a possible future
// admin-editable list, not built now). The "Butter Chicken" -> "Paneer" swap mirrors the
// same swap search.service.js's popular-searches seed lists make for veg mode.
const QUICK_FILTER_CHIPS_STANDARD = [
  { label: 'Biryani', iconUrl: null, queryParam: 'Biryani' },
  { label: 'Butter Chicken', iconUrl: null, queryParam: 'Butter Chicken' },
  { label: 'Pizza', iconUrl: null, queryParam: 'Pizza' },
  { label: 'Sandwich', iconUrl: null, queryParam: 'Sandwich' },
  { label: 'Dosa', iconUrl: null, queryParam: 'Dosa' },
];
const QUICK_FILTER_CHIPS_VEG = [
  { label: 'Biryani', iconUrl: null, queryParam: 'Biryani' },
  { label: 'Paneer', iconUrl: null, queryParam: 'Paneer' },
  { label: 'Pizza', iconUrl: null, queryParam: 'Pizza' },
  { label: 'Sandwich', iconUrl: null, queryParam: 'Sandwich' },
  { label: 'Dosa', iconUrl: null, queryParam: 'Dosa' },
];

const VEG_BANNER_TEXT = 'Pure veg mode is on — showing only vegetarian food';

// Sourced from the SAME nearby restaurant set the caller already fetched for
// nearbyRestaurants (by id), never a second restaurant query — same principle the prompt
// states explicitly for recommendedRestaurants, extended here to where recommendedItems
// are drawn from. `restaurant.avgRating` isn't a MenuItem field, so this needs an actual
// join (one aggregation, not N+1) to sort by it.
const getRecommendedItems = async (restaurantIds, vegMode) => {
  if (restaurantIds.length === 0) return [];

  // A buffer over the final cap when veg mode is on: some pulled items get dropped
  // (non-veg with no linked substitute) or swapped 1:1 for their substitute, so pulling
  // exactly the cap risks under-filling the final list.
  const pullLimit = vegMode ? RECOMMENDED_ITEMS_LIMIT * 3 : RECOMMENDED_ITEMS_LIMIT;

  const items = await MenuItem.aggregate([
    { $match: { restaurantId: { $in: restaurantIds }, isAvailable: true } },
    {
      $lookup: {
        from: 'restaurants',
        localField: 'restaurantId',
        foreignField: '_id',
        as: 'restaurant',
      },
    },
    { $unwind: '$restaurant' },
    { $sort: { 'restaurant.avgRating': -1, createdAt: -1 } },
    { $limit: pullLimit },
    { $project: { restaurant: 0 } },
  ]);

  if (!vegMode) return items.slice(0, RECOMMENDED_ITEMS_LIMIT);

  // Veg mode: a non-veg item with a linked veg substitute (Prompt 5's vegVariantId) is
  // swapped for that substitute; a non-veg item with NO substitute is dropped outright —
  // matching the Home banner's literal promise ("showing only vegetarian food") rather
  // than a best-effort filter that still leaks non-veg items with nothing to swap to.
  const variantIds = items.filter((i) => i.foodType !== 'veg' && i.vegVariantId).map((i) => i.vegVariantId);
  const variants = variantIds.length > 0
    ? await MenuItem.find({ _id: { $in: variantIds }, isAvailable: true }).lean({ virtuals: true })
    : [];
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  const resolved = [];
  for (const item of items) {
    if (item.foodType === 'veg') {
      resolved.push(item);
    } else if (item.vegVariantId) {
      const variant = variantById.get(String(item.vegVariantId));
      if (variant) resolved.push(variant); // substitute link points at something unavailable/missing — drop, don't show non-veg
    }
    // else: non-veg with no substitute at all — dropped
    if (resolved.length >= RECOMMENDED_ITEMS_LIMIT) break;
  }
  return resolved;
};

// "Platform-wide" here means "eligible to surface on the general Home feed", scoped to
// restaurants actually near this customer — not a literal restaurant-less global entity
// (Discount.restaurantId stays required; see the model comment on isFeatured).
const getFeaturedBanner = async (restaurantIds) => {
  if (restaurantIds.length === 0) return null;

  const now = new Date();
  const discount = await Discount.findOne({
    restaurantId: { $in: restaurantIds },
    status: 'active',
    isFeatured: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!discount) return null;

  return {
    discountId: discount._id,
    restaurantId: discount.restaurantId,
    offerName: discount.offerName,
    code: discount.code,
    image: discount.image ?? null,
    type: discount.type,
    percentage: discount.percentage,
    flatAmount: discount.flatAmount,
  };
};

export const getHomeFeed = async ({
  lat,
  lng,
  radius = 5,
  vegMode = false,
  vegScope = 'all_restaurants',
}) => {
  // isPureVeg-only when scope is pure_veg_only; when scope is all_restaurants (or veg
  // mode is off), no restaurant is excluded — recommendedItems is what carries the
  // veg-mode substitution/filtering in that case instead.
  const extraFilter = vegMode && vegScope === 'pure_veg_only' ? { isPureVeg: true } : {};

  const nearbyRestaurants = await restaurantService.findNearby(lat, lng, radius, {
    page: 1,
    limit: NEARBY_LIMIT,
    extraFilter,
  });
  const restaurantIds = nearbyRestaurants.map((r) => r._id);

  const startingPrices = await menuService.getStartingPrices(restaurantIds);
  for (const r of nearbyRestaurants) r.startingPrice = startingPrices.get(String(r._id)) ?? null;

  // Re-sort a COPY by rating instead of distance — the SAME restaurant objects as
  // nearbyRestaurants (startingPrice already attached above applies to both views), not a
  // second query, per the prompt's explicit "do not build a second data source" note.
  const recommendedRestaurants = [...nearbyRestaurants].sort(
    (a, b) => (b.avgRating ?? 0) - (a.avgRating ?? 0)
  );

  const [recommendedItems, banner] = await Promise.all([
    getRecommendedItems(restaurantIds, vegMode),
    getFeaturedBanner(restaurantIds),
  ]);

  return {
    nearbyRestaurants,
    recommendedRestaurants,
    recommendedItems,
    quickFilterChips: vegMode ? QUICK_FILTER_CHIPS_VEG : QUICK_FILTER_CHIPS_STANDARD,
    banner,
    vegBannerText: vegMode ? VEG_BANNER_TEXT : null,
  };
};
