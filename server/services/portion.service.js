// Half / full plate pricing. A dish with MenuItem.halfPlatePrice set comes in two sizes:
// sellingPrice (or its discounted price) is the full plate, halfPlatePrice the half.
//
// Two ordering paths read it:
//   • table QR, waiter and other raw-item orders send `portion: 'half' | 'full'` per line —
//     resolvePortion() prices and names the line;
//   • the customer app's cart works through item option groups, so every two-size dish also
//     carries a server-maintained "Plate size" option group (systemKey 'portion') that
//     syncPortionGroup() keeps in step with the prices. Full plate is the default (+₹0);
//     Half plate carries the (negative) difference.

import OptionGroup from '../models/OptionGroup.js';
import { ApiError } from '../utils/ApiError.js';

export const PORTION_GROUP_TITLE = 'Plate size';
export const FULL_OPTION = 'Full plate';
export const HALF_OPTION = 'Half plate';

const fullPriceOf = (menuItem) => menuItem.discountedPrice ?? menuItem.sellingPrice;
const round2 = (n) => Math.round(n * 100) / 100;

export const hasPortions = (menuItem) => menuItem?.halfPlatePrice != null;

/** The line a raw-item order gets for this dish and requested size. */
export const resolvePortion = (menuItem, portion) => {
  if (!hasPortions(menuItem)) {
    if (portion === 'half') {
      throw new ApiError(400, 'VALIDATION_ERROR', `"${menuItem.name}" is not sold as a half plate`);
    }
    return { name: menuItem.name, price: fullPriceOf(menuItem), portion: null };
  }
  if (portion === 'half') {
    return { name: `${menuItem.name} (Half)`, price: menuItem.halfPlatePrice, portion: 'half' };
  }
  return { name: `${menuItem.name} (Full)`, price: fullPriceOf(menuItem), portion: 'full' };
};

/** For a cart line priced through option groups: which size it picked, if the dish has two. */
export const portionFromSelections = (groups = [], selectedOptions = []) => {
  const group = groups.find((g) => g.systemKey === 'portion');
  if (!group) return null;
  const picked = (selectedOptions ?? []).find((s) => String(s.groupId) === String(group._id));
  const option = picked && group.options.find((o) => String(o._id) === String(picked.optionId));
  if (!option) return null;
  return option.name === HALF_OPTION ? 'half' : 'full';
};

export const nameWithPortion = (name, portion) =>
  portion === 'half' ? `${name} (Half)` : portion === 'full' ? `${name} (Full)` : name;

/**
 * Create, update or remove the item's "Plate size" option group so it matches its prices.
 * Option ids are kept on update, so carts already holding a selection stay valid.
 */
export const syncPortionGroup = async (menuItem) => {
  const existing = await OptionGroup.findOne({ menuItemId: menuItem._id, systemKey: 'portion' });
  if (!hasPortions(menuItem)) {
    if (existing) await existing.deleteOne();
    return null;
  }
  const halfDelta = round2(menuItem.halfPlatePrice - fullPriceOf(menuItem));
  if (!existing) {
    return OptionGroup.create({
      menuItemId: menuItem._id,
      title: PORTION_GROUP_TITLE,
      type: 'single_choice',
      required: true,
      sortOrder: -1,
      systemKey: 'portion',
      options: [
        { name: FULL_OPTION, priceDeltaMinor: 0, isDefaultSelected: true },
        { name: HALF_OPTION, priceDeltaMinor: halfDelta },
      ],
    });
  }
  const half = existing.options.find((o) => o.name === HALF_OPTION);
  if (half) half.priceDeltaMinor = halfDelta;
  else existing.options.push({ name: HALF_OPTION, priceDeltaMinor: halfDelta });
  await existing.save();
  return existing;
};
