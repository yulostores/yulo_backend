import MenuItem from '../models/MenuItem.js';
import OptionGroup from '../models/OptionGroup.js';
import Category from '../models/Category.js';
import Restaurant from '../models/Restaurant.js';
import * as favoriteService from '../services/favorite.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getItem = asyncHandler(async (req, res) => {
  const item = await MenuItem.findOne({
    _id: req.params.id,
    isAvailable: true,
  }).lean({ virtuals: true });
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');

  // The item document stores only `categoryId` / `restaurantId`. The detail
  // screen shows the dish's kind and which kitchen it's from as a subtitle, so
  // resolve both names here rather than making the client fetch them separately.
  const [optionGroups, category, restaurant] = await Promise.all([
    OptionGroup.find({ menuItemId: item._id }).sort({ sortOrder: 1 }).lean(),
    Category.findById(item.categoryId).select('name').lean(),
    Restaurant.findById(item.restaurantId).select('name cuisineTypes').lean(),
  ]);

  item.optionGroups = optionGroups;
  item.category = category ? { _id: category._id, name: category.name } : null;
  item.restaurant = restaurant
    ? { _id: restaurant._id, name: restaurant.name, cuisineTypes: restaurant.cuisineTypes ?? [] }
    : null;

  const favoritedIds = req.user
    ? await favoriteService.getFavoritedIdSet(req.user._id, 'menu_item')
    : null;
  favoriteService.annotateEntity(item, favoritedIds);

  sendSuccess(res, 200, 'Item detail', { item });
});
