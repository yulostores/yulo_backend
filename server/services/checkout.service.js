import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import * as cartService from './cart.service.js';
import * as menuService from './menu.service.js';
import { tipPresets } from '../config/finance.config.js';

const MEAL_SECTION_ITEM_LIMIT = 8;

// Backs the checkout page's "Complete your meal" strip — a synthetic "Popular" bucket
// (bestseller-badged items first, then most recent — the same "top-rated items from
// this restaurant" reading the old single-list upsell used) followed by the
// restaurant's own real menu categories, each already excluding whatever's in the
// cart. Built from the same cached getMenu() data the menu endpoints already use, not
// a fresh MenuItem query or a separate recommendation engine.
const getCompleteYourMealSections = async (restaurantId, excludeMenuItemIds) => {
  const menu = await menuService.getMenu(restaurantId);
  const excluded = new Set(excludeMenuItemIds.map(String));

  const flatten = (category) => [
    ...(category.items || []),
    ...(category.subCategories || []).flatMap((sub) => sub.items || []),
  ];

  const available = (items) =>
    items.filter((item) => !excluded.has(String(item._id)) && item.isAvailable !== false);

  // A lean display shape, not the raw getMenu() item — that carries the full
  // `optionGroups` array (pricing rules, every option), which this card grid never
  // renders. `optionGroupCount` is what the "+" button needs to know whether adding
  // this item straight to the cart is even valid (0 groups) or whether it has to send
  // the customer to /item/:id to pick required customizations first — the same signal
  // attachOptionGroupCounts gives the restaurant menu's own ADD button.
  const toMealItem = (item) => ({
    _id: item._id,
    name: item.name,
    description: item.description ?? null,
    image: item.image ?? null,
    foodType: item.foodType,
    sellingPrice: item.sellingPrice,
    discountedPrice: item.discountedPrice ?? null,
    effectivePrice: item.effectivePrice,
    badges: item.badges ?? [],
    optionGroupCount: item.optionGroups?.length ?? 0,
  });

  const popular = available(menu.flatMap(flatten))
    .sort((a, b) => {
      const aBestseller = a.badges?.includes('bestseller') ? 1 : 0;
      const bBestseller = b.badges?.includes('bestseller') ? 1 : 0;
      if (aBestseller !== bBestseller) return bBestseller - aBestseller;
      return new Date(b.createdAt) - new Date(a.createdAt);
    })
    .slice(0, MEAL_SECTION_ITEM_LIMIT)
    .map(toMealItem);

  const categorySections = menu
    .map((category) => ({
      id: String(category._id),
      name: category.name,
      items: available(flatten(category)).slice(0, MEAL_SECTION_ITEM_LIMIT).map(toMealItem),
    }))
    .filter((section) => section.items.length > 0);

  const sections = [];
  if (popular.length > 0) sections.push({ id: 'popular', name: 'Popular', items: popular });
  sections.push(...categorySections);
  return sections;
};

// `cartId` (if the caller passes one — there's only ever one cart per user, see Prompt 9)
// is accepted but unused; this always reads the caller's own current cart.
export const getCheckoutSummary = async (userId) => {
  const [{ cart, bill }, user] = await Promise.all([
    cartService.getCart(userId),
    User.findById(userId).select('savedAddresses preferences').lean(),
  ]);

  const address = user.savedAddresses.find((a) => a.isDefault) || user.savedAddresses[0] || null;

  let mealSections = [];
  let vegFleetEligible = false;

  if (cart.restaurantId) {
    const restaurant = await Restaurant.findById(cart.restaurantId).select('vegFleetAvailable').lean();
    vegFleetEligible = Boolean(user.preferences?.vegModeEnabled && restaurant?.vegFleetAvailable);
    mealSections = await getCompleteYourMealSections(
      cart.restaurantId,
      cart.items.map((i) => i.menuItemId)
    );
  }

  return { address, cart, bill, mealSections, vegFleetEligible, tipPresets };
};
