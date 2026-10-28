import MenuItem from '../models/MenuItem.js';
import { ApiError } from '../utils/ApiError.js';
import { now as clockNow } from '../utils/clock.js';
import { toPaise } from '../utils/money.js';

// A personal offer (`kind: 'personal'`, live customer activity) is one customer's, sent by the
// owner from the live dashboard. It is validated with its own checks first, so an expired,
// revoked or used one always gets the codes the app maps (OFFER_EXPIRED / OFFER_ALREADY_USED…),
// never the generic NOT_FOUND / DISCOUNT_EXPIRED below.
const isPersonal = (discount) => discount?.kind === 'personal';

const validatePersonalOffer = (discount, { subtotal, userId, restaurantId, cartMenuItemIds, now }) => {
  // Someone else's offer: never reveal that it exists.
  if (!userId || String(discount.targetUserId) !== String(userId)) {
    throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  }
  if (restaurantId !== undefined && String(discount.restaurantId) !== String(restaurantId)) {
    throw new ApiError(400, 'OFFER_NOT_APPLICABLE', 'This offer is for another restaurant');
  }
  if (['expired', 'revoked'].includes(discount.offerStatus) || (discount.endDate && now > discount.endDate)) {
    throw new ApiError(409, 'OFFER_EXPIRED', 'This offer has expired');
  }
  if (discount.offerStatus === 'redeemed' || (discount.redemptionCount ?? 0) >= (discount.maxRedemptions ?? 1)) {
    throw new ApiError(409, 'OFFER_ALREADY_USED', 'This offer has already been used');
  }
  if (discount.applicableItems?.length && cartMenuItemIds) {
    const inCart = new Set(cartMenuItemIds.map(String));
    if (!discount.applicableItems.some((id) => inCart.has(String(id)))) {
      throw new ApiError(400, 'OFFER_NOT_APPLICABLE', 'None of the items this offer is for are in your cart');
    }
  }
  // Against the whole food subtotal (not just the offer's items), like every discount.
  if (subtotal < (discount.minimumOrderValue ?? 0)) {
    throw new ApiError(400, 'DISCOUNT_MIN_VALUE', `Minimum order value is ₹${discount.minimumOrderValue}`, {
      shortfallPaise: toPaise(discount.minimumOrderValue) - toPaise(subtotal),
    });
  }
};

// Shared by billing.service.js's dine-in bill discount application and the customer
// cart's apply-promo (services/cart.service.js) — the same active/date-range/
// minimum-order/applicable-to checks in exactly one place, not duplicated per call site.
// `userId`, `restaurantId`, `cartMenuItemIds` and `now` matter only to personal offers (above);
// public discounts are checked exactly as before.
export const validateDiscountForOrder = (
  discount,
  { subtotal, orderType, userId, restaurantId, cartMenuItemIds, now = clockNow() }
) => {
  if (isPersonal(discount)) validatePersonalOffer(discount, { subtotal, userId, restaurantId, cartMenuItemIds, now });

  if (!discount || discount.status !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Discount code not found or inactive');
  }

  if (now < discount.startDate || now > discount.endDate) {
    throw new ApiError(400, 'DISCOUNT_EXPIRED', 'This offer has expired');
  }

  if (subtotal < discount.minimumOrderValue) {
    throw new ApiError(
      400,
      'DISCOUNT_MIN_VALUE',
      `Minimum order value is ₹${discount.minimumOrderValue}`
    );
  }

  // billing.service.js never checked this before — a delivery-only discount could be
  // applied to a dine-in bill. Adding it here is a correctness fix, not just a
  // cart-specific addition: it matches what `applicableTo` was already declared for.
  if (orderType && discount.applicableTo !== 'both' && discount.applicableTo !== orderType) {
    throw new ApiError(
      400,
      'DISCOUNT_NOT_APPLICABLE',
      `This offer only applies to ${discount.applicableTo.replace('_', '-')} orders`
    );
  }
};

/**
 * A personal offer's saving in paise for `lines` (`[{ menuItemId, amountPaise }]`, one per cart
 * or order line, amount = unit price × qty). The percentage applies only to the offer's items
 * (every line when `applicableItems` is empty) and is rounded once, half up, in paise — the
 * same rule toPaise applies to every other discount; then capped at `maxDiscountAmount`. A flat
 * amount is capped too, and neither is ever more than the eligible subtotal.
 */
export const personalOfferSavingPaise = (offer, lines) => {
  const only = offer.applicableItems?.length ? new Set(offer.applicableItems.map(String)) : null;
  const eligiblePaise = lines.reduce(
    (sum, line) => (!only || only.has(String(line.menuItemId)) ? sum + line.amountPaise : sum),
    0
  );
  const raw = offer.type === 'percentage' ? Math.round((eligiblePaise * offer.percentage) / 100) : toPaise(offer.flatAmount);
  return { eligiblePaise, savingPaise: Math.max(0, Math.min(raw, toPaise(offer.maxDiscountAmount), eligiblePaise)) };
};

/**
 * Discount in rupees, as every caller expects. `lines` (paise per line, see above) is needed
 * for a personal offer, whose percentage applies to its own items only.
 */
export const computeDiscountAmount = async (discount, subtotal, { lines } = {}) => {
  if (isPersonal(discount)) {
    const fallback = [{ menuItemId: null, amountPaise: toPaise(subtotal) }];
    return personalOfferSavingPaise(discount, lines ?? fallback).savingPaise / 100;
  }
  if (discount.type === 'percentage') return subtotal * (discount.percentage / 100);
  if (discount.type === 'flat_amount') return discount.flatAmount;
  if (discount.type === 'tablewise') return discount.flatAmount;
  if (discount.type === 'free_item') {
    const freeItem = await MenuItem.findById(discount.freeItemId).lean();
    return freeItem?.sellingPrice ?? 0;
  }
  return 0;
};
