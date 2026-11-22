import MenuItem from '../../models/MenuItem.js';
import OptionGroup from '../../models/OptionGroup.js';
import * as menuService from '../../services/menu.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Unlike category/subcategory (which only check the immediate parent id param), this
// checks the full restaurant -> item chain on every request — option-groups are a brand
// new resource with no established shortcut to mirror, so there's no reason to carry the
// looser sibling pattern forward here.
const findOwnedMenuItem = async (restaurantId, itemId) => {
  const item = await MenuItem.findOne({ _id: itemId, restaurantId }).lean();
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  return item;
};

export const list = asyncHandler(async (req, res) => {
  await findOwnedMenuItem(req.restaurant._id, req.params.itemId);
  const optionGroups = await OptionGroup.find({ menuItemId: req.params.itemId })
    .sort({ sortOrder: 1 })
    .lean();
  sendSuccess(res, 200, 'Option groups', { optionGroups });
});

export const create = asyncHandler(async (req, res) => {
  await findOwnedMenuItem(req.restaurant._id, req.params.itemId);
  const { title, type, required, minSelect, maxSelect, sortOrder, options } = req.body;

  const optionGroup = await OptionGroup.create({
    menuItemId: req.params.itemId,
    title,
    type,
    required: required ?? false,
    minSelect: minSelect ?? 0,
    maxSelect: maxSelect ?? null,
    sortOrder: sortOrder ?? 0,
    options: options ?? [],
  });

  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 201, 'Option group created', { optionGroup });
});

export const update = asyncHandler(async (req, res) => {
  await findOwnedMenuItem(req.restaurant._id, req.params.itemId);

  // Full replace of `options` on PATCH (same "$set: req.body" convention as
  // updateCategory/updateSubCategory) — send the complete options array, not a diff.
  const optionGroup = await OptionGroup.findOneAndUpdate(
    // The "Plate size" group follows the item's prices (services/portion.service.js) — it is
    // changed through the item, never directly.
    { _id: req.params.groupId, menuItemId: req.params.itemId, systemKey: null },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!optionGroup) throw new ApiError(404, 'NOT_FOUND', 'Option group not found');

  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Option group updated', { optionGroup });
});

export const remove = asyncHandler(async (req, res) => {
  await findOwnedMenuItem(req.restaurant._id, req.params.itemId);

  const optionGroup = await OptionGroup.findOneAndDelete({
    _id: req.params.groupId,
    menuItemId: req.params.itemId,
    systemKey: null,
  });
  if (!optionGroup) throw new ApiError(404, 'NOT_FOUND', 'Option group not found');

  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Option group deleted', null);
});
