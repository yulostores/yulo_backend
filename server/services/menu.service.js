import MenuItem from '../models/MenuItem.js';
import Category from '../models/Category.js';
import SubCategory from '../models/SubCategory.js';
import OptionGroup from '../models/OptionGroup.js';
import * as cacheService from './cache.service.js';
import { escapeRegExp } from '../utils/regex.js';

export const getMenu = async (restaurantId) => {
  const cacheKey = `cache:menu:${restaurantId}`;

  const cached = await cacheService.get(cacheKey);
  if (cached) return cached;

  const [items, categories, subcategories] = await Promise.all([
    MenuItem.find({ restaurantId, isAvailable: true }).lean({ virtuals: true }),
    Category.find({ restaurantId }).sort({ displayOrder: 1 }).lean(),
    SubCategory.find({ restaurantId }).lean(),
  ]);

  // One batch query for every item's option groups, not one query per item.
  const optionGroups = await OptionGroup.find({ menuItemId: { $in: items.map((i) => i._id) } })
    .sort({ sortOrder: 1 })
    .lean();
  const optionGroupsByItemId = new Map();
  for (const group of optionGroups) {
    const key = String(group.menuItemId);
    if (!optionGroupsByItemId.has(key)) optionGroupsByItemId.set(key, []);
    optionGroupsByItemId.get(key).push(group);
  }
  for (const item of items) {
    item.optionGroups = optionGroupsByItemId.get(String(item._id)) ?? [];
  }

  const grouped = categories.map((cat) => ({
    ...cat,
    subCategories: subcategories
      .filter((s) => s.categoryId.equals(cat._id))
      .map((sub) => ({
        ...sub,
        items: items.filter((i) => i.subCategoryId?.equals(sub._id)),
      })),
    items: items.filter((i) => i.categoryId.equals(cat._id) && !i.subCategoryId),
  }));

  await cacheService.set(cacheKey, grouped, 300);
  return grouped;
};

export const invalidateMenu = (restaurantId) =>
  cacheService.invalidate(`cache:menu:${restaurantId}`);

// Flattens getMenu()'s grouped shape (category.items + category.subCategories[].items)
// into a single list — used by both helpers below, which both start from the same
// already-cached menu rather than issuing their own MenuItem queries.
const flattenMenuItems = (menu) => {
  const items = [];
  for (const category of menu) {
    items.push(...(category.items || []));
    for (const sub of category.subCategories || []) items.push(...(sub.items || []));
  }
  return items;
};

// Menu-scoped search (screen 15's "search in menu" bar) — reuses getMenu()'s 5-min cache
// instead of hitting Mongo again on every keystroke.
export const searchMenu = async (restaurantId, query) => {
  const menu = await getMenu(restaurantId);
  const regex = new RegExp(escapeRegExp(query.trim()), 'i');
  return flattenMenuItems(menu).filter(
    (item) => regex.test(item.name) || regex.test(item.description ?? '')
  );
};

// Lightweight category jump-sheet (screen 15) — a separate, smaller shape from the full
// menu payload (screen 14), but built from the same cached getMenu() call rather than a
// fresh Category/SubCategory query.
export const getMenuCategories = async (restaurantId) => {
  const menu = await getMenu(restaurantId);
  return menu.map((cat) => ({
    id: cat._id,
    name: cat.name,
    itemCount:
      (cat.items?.length ?? 0) +
      (cat.subCategories ?? []).reduce((sum, sub) => sum + (sub.items?.length ?? 0), 0),
    subCategories: (cat.subCategories ?? []).map((sub) => ({ id: sub._id, name: sub.name })),
  }));
};

// Per-item count of customization groups, for the lazy menu feed and the in-menu
// search. One query for the whole page (not one per item), mirroring how
// getMenu() attaches the full optionGroups array in a single batch. The customer
// app's ADD button reads this to decide whether a tap adds the dish straight to
// the cart or hands off to the customization screen first.
//
// Model.find() (unlike .aggregate()) casts the ids per the schema, so a string
// id coming off a JSON-cached menu entry (searchMenu) works the same as a live
// ObjectId (listMenuItems).
export const attachOptionGroupCounts = async (items) => {
  if (items.length === 0) return items;

  const groups = await OptionGroup.find({ menuItemId: { $in: items.map((i) => i._id) } })
    .select('menuItemId')
    .lean();

  const countByItemId = new Map();
  for (const g of groups) {
    const key = String(g.menuItemId);
    countByItemId.set(key, (countByItemId.get(key) ?? 0) + 1);
  }

  for (const item of items) {
    item.optionGroupCount = countByItemId.get(String(item._id)) ?? 0;
  }
  return items;
};

// Backs the `startingPrice` field on restaurant list/search cards — one aggregation for
// N restaurants, not N queries. Field name (not `startingPriceMinor`) matches how every
// other price on MenuItem/Order/Bill in this codebase is actually stored: plain rupee
// numbers, not minor/paise units — see the note in API.md's Customer — Search section.
export const getStartingPrices = async (restaurantIds) => {
  if (restaurantIds.length === 0) return new Map();

  const rows = await MenuItem.aggregate([
    { $match: { restaurantId: { $in: restaurantIds }, isAvailable: true } },
    {
      $group: {
        _id: '$restaurantId',
        startingPrice: { $min: { $ifNull: ['$discountedPrice', '$sellingPrice'] } },
      },
    },
  ]);

  return new Map(rows.map((r) => [String(r._id), r.startingPrice]));
};
