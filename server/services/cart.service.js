import Cart from '../models/Cart.js';
import MenuItem from '../models/MenuItem.js';
import OptionGroup from '../models/OptionGroup.js';
import Restaurant from '../models/Restaurant.js';
import Discount from '../models/Discount.js';
import { computeItemPrice } from './pricing.service.js';
import * as discountService from './discount.service.js';
import { cartPlatformFee, cartTaxPercent } from '../config/finance.config.js';
import { ApiError } from '../utils/ApiError.js';

const getOrCreateCart = (userId) =>
  Cart.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

// Exported — services/order.service.js's checkout re-validation recomputes the same fee
// from fresh restaurant data at order-placement time, rather than trusting whatever the
// cart displayed while browsing.
export const computeDeliveryFee = (itemTotal, delivery) => {
  const baseCharge = delivery?.baseCharge ?? 0;
  const freeThreshold = delivery?.freeThreshold;
  if (freeThreshold != null && itemTotal >= freeThreshold) return 0;
  return baseCharge;
};

// Bridges Cart's stored { optionId, qty } selections to the { groupId, optionId, qty }
// shape computeItemPrice (pricing.service.js) needs, then validates+prices via it.
// Exported so order.service.js's checkout re-validation enforces an item's customization
// rules identically at final order-placement time as it did at add-to-cart time — not a
// second, slightly-different implementation of the same bridging logic.
export const priceItemSelection = (menuItem, optionGroups, selectedOptions) => {
  const groupIdByOptionId = new Map();
  for (const group of optionGroups) {
    for (const option of group.options) groupIdByOptionId.set(String(option._id), group._id);
  }

  const selectionsWithGroupId = [];
  for (const sel of selectedOptions) {
    const groupId = groupIdByOptionId.get(String(sel.optionId));
    if (!groupId) {
      return { valid: false, errors: [`Unknown option: ${sel.optionId}`], totalPriceMinor: null };
    }
    selectionsWithGroupId.push({ groupId, optionId: sel.optionId, qty: sel.qty });
  }

  return computeItemPrice(menuItem.effectivePrice, optionGroups, selectionsWithGroupId);
};

// Whenever the cart empties out, forget which restaurant it belonged to (and any applied
// discount, which is restaurant-scoped) — otherwise the NEXT add from a *different*
// restaurant would spuriously hit the CART_RESTAURANT_CONFLICT check against a cart that
// has no actual items left in it.
const resetIfEmpty = (cart) => {
  if (cart.items.length === 0) {
    cart.restaurantId = null;
    cart.appliedDiscountId = null;
  }
};

// Resolves each stored selectedOption's name/priceDelta for display — Cart only stores
// { optionId, qty } (see the model), so the client needs this to render what was actually
// picked without a second round-trip per item. One batch OptionGroup query for the whole
// cart, not one per line item.
//
// IMPORTANT: `items` must already be plain objects (post cart.toObject()), not live
// Mongoose subdocuments — Mongoose's toJSON()/toObject() serializes from its internal
// _doc, so an ad-hoc property assigned directly onto a subdocument instance (which is
// exactly what this function does) is readable in-process but silently absent from the
// actual JSON response. See buildCartResponse below, the only caller.
const resolveSelectedOptions = async (items) => {
  if (items.length === 0) return;

  const menuItemIds = [...new Set(items.map((i) => String(i.menuItemId)))];
  const groups = await OptionGroup.find({ menuItemId: { $in: menuItemIds } }).lean();

  const optionById = new Map();
  for (const group of groups) {
    for (const option of group.options) optionById.set(String(option._id), option);
  }

  for (const item of items) {
    item.resolvedOptions = item.selectedOptions.map((sel) => {
      const option = optionById.get(String(sel.optionId));
      return {
        optionId: sel.optionId,
        qty: sel.qty,
        name: option?.name ?? null,
        priceDelta: option?.priceDeltaMinor ?? 0,
      };
    });
  }
};

// `restaurant` is passed in by buildCartResponse (which already loads it for the
// cart's storefront summary) so the bill doesn't re-query the same document; it
// falls back to its own lookup for any other caller.
export const computeBill = async (cart, restaurant) => {
  if (cart.items.length === 0) {
    return { itemTotal: 0, deliveryFee: 0, platformFee: 0, tax: 0, discountAmount: 0, grandTotal: 0 };
  }

  const itemTotal = cart.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);

  const restaurantDoc =
    restaurant ?? (await Restaurant.findById(cart.restaurantId).select('delivery').lean());
  const deliveryFee = computeDeliveryFee(itemTotal, restaurantDoc?.delivery);
  const platformFee = cartPlatformFee;
  const tax = itemTotal * (cartTaxPercent / 100);

  let discountAmount = 0;
  if (cart.appliedDiscountId) {
    const discount = await Discount.findById(cart.appliedDiscountId).lean();
    // Re-validated on every read, not just at apply-time — if items were removed since
    // and the cart no longer meets minimumOrderValue (or the discount has since expired),
    // it silently stops applying rather than showing a stale total. appliedDiscountId is
    // deliberately left on the cart either way (not auto-cleared): if the customer adds
    // items back and it becomes valid again, it resumes applying without re-entering the code.
    try {
      discountService.validateDiscountForOrder(discount, { subtotal: itemTotal, orderType: 'delivery' });
      discountAmount = await discountService.computeDiscountAmount(discount, itemTotal);
    } catch {
      discountAmount = 0;
    }
  }

  const grandTotal = itemTotal + deliveryFee + platformFee + tax - discountAmount;
  return { itemTotal, deliveryFee, platformFee, tax, discountAmount, grandTotal };
};

// Fills in `foodType` on any line that predates the Cart schema snapshotting it
// (see Cart.js). One batch MenuItem query for the whole cart, mirroring how
// resolveSelectedOptions handles OptionGroups.
const backfillFoodTypes = async (items) => {
  const missing = items.filter((i) => !i.foodType);
  if (missing.length === 0) return;

  const ids = [...new Set(missing.map((i) => String(i.menuItemId)))];
  const menuItems = await MenuItem.find({ _id: { $in: ids } }).select('foodType').lean();
  const foodTypeById = new Map(menuItems.map((m) => [String(m._id), m.foodType]));

  for (const item of missing) {
    item.foodType = foodTypeById.get(String(item.menuItemId)) ?? null;
  }
};

// Storefront summary the cart screen renders above the line items — its name, a
// thumbnail, and whether it's fully vegetarian. `null` for an empty cart, whose
// restaurantId has been reset (see resetIfEmpty).
const loadRestaurantSummary = async (restaurantId) => {
  if (!restaurantId) return null;
  const r = await Restaurant.findById(restaurantId)
    .select('name logo coverImage bannerImage isPureVeg delivery')
    .lean();
  if (!r) return null;
  return {
    _id: r._id,
    name: r.name,
    image: r.logo || r.coverImage || r.bannerImage || null,
    isPureVeg: Boolean(r.isPureVeg),
    // kept on the object only so computeBill can reuse it; stripped before response
    delivery: r.delivery,
  };
};

// Single place every mutating/read function below funnels through before returning —
// converts to a plain object FIRST, so resolveSelectedOptions' ad-hoc `resolvedOptions`
// property actually survives JSON serialization (see that function's comment).
const buildCartResponse = async (cart) => {
  const plainCart = cart.toObject();
  const restaurant = await loadRestaurantSummary(plainCart.restaurantId);
  await Promise.all([
    resolveSelectedOptions(plainCart.items),
    backfillFoodTypes(plainCart.items),
  ]);
  const bill = await computeBill(plainCart, restaurant ? { delivery: restaurant.delivery } : undefined);
  if (restaurant) delete restaurant.delivery;
  plainCart.restaurant = restaurant;
  return { cart: plainCart, bill };
};

export const getCart = async (userId) => {
  const cart = await getOrCreateCart(userId);
  return buildCartResponse(cart);
};

export const addItem = async (userId, { menuItemId, qty, selectedOptions = [] }) => {
  const cart = await getOrCreateCart(userId);

  const menuItem = await MenuItem.findOne({ _id: menuItemId, isAvailable: true }).lean({ virtuals: true });
  if (!menuItem) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');

  if (cart.items.length > 0 && String(cart.restaurantId) !== String(menuItem.restaurantId)) {
    const currentRestaurant = await Restaurant.findById(cart.restaurantId).select('name').lean();
    throw new ApiError(
      409,
      'CART_RESTAURANT_CONFLICT',
      'Your cart has items from another restaurant',
      { currentRestaurantName: currentRestaurant?.name ?? null }
    );
  }

  const optionGroups = await OptionGroup.find({ menuItemId }).lean();
  const pricing = priceItemSelection(menuItem, optionGroups, selectedOptions);
  if (!pricing.valid) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid item customization', { errors: pricing.errors });
  }

  // Always a new line — two POSTs for the "same" item/customization produce two lines,
  // not a merged quantity. Increasing quantity of an existing line is what
  // PATCH /api/cart/items/:lineItemId is for.
  cart.items.push({
    menuItemId: menuItem._id,
    name: menuItem.name,
    unitPrice: pricing.totalPriceMinor,
    qty,
    foodType: menuItem.foodType,
    selectedOptions,
  });
  cart.restaurantId = menuItem.restaurantId;

  await cart.save();
  return buildCartResponse(cart);
};

export const removeItem = async (userId, lineItemId) => {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.id(lineItemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Cart item not found');

  cart.items.pull(lineItemId);
  resetIfEmpty(cart);

  await cart.save();
  return buildCartResponse(cart);
};

export const updateItemQty = async (userId, lineItemId, qty) => {
  if (qty <= 0) return removeItem(userId, lineItemId);

  const cart = await getOrCreateCart(userId);
  const item = cart.items.id(lineItemId);
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Cart item not found');

  item.qty = qty;
  await cart.save();
  return buildCartResponse(cart);
};

export const clearCart = async (userId) => {
  const cart = await getOrCreateCart(userId);
  cart.items = [];
  cart.restaurantId = null;
  cart.appliedDiscountId = null;
  await cart.save();
  return buildCartResponse(cart);
};

export const applyPromo = async (userId, code) => {
  const cart = await getOrCreateCart(userId);
  if (!cart.restaurantId) throw new ApiError(400, 'VALIDATION_ERROR', 'Cart is empty');

  const discount = await Discount.findOne({ code, restaurantId: cart.restaurantId }).lean();
  const itemTotal = cart.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
  discountService.validateDiscountForOrder(discount, { subtotal: itemTotal, orderType: 'delivery' });

  cart.appliedDiscountId = discount._id;
  await cart.save();
  return buildCartResponse(cart);
};
