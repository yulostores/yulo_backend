import MenuItem from '../../models/MenuItem.js';
import Category from '../../models/Category.js';
import * as uploadService from '../../services/upload.service.js';
import * as menuService from '../../services/menu.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  const items = await MenuItem.find({ restaurantId: req.restaurant._id }).lean();
  sendSuccess(res, 200, 'Menu items', { items });
});

// Also used for `badges` — both are array fields arriving as a JSON-encoded string over
// multipart/form-data (e.g. '["tomato","cream"]'), same as the rest of this form.
const parseArrayField = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return [raw]; }
};

// Prices are what customers are charged, so they are checked here rather than trusted from
// the form: an MRP must be a real positive amount, and a "discounted" price must be a real
// discount — positive and not above the MRP. A discount above the MRP was accepted before,
// and the customer was charged it (₹300 for a ₹280-MRP dish). An empty discount means none.
const parsePrice = (raw, label) => {
  const n = Number(raw);
  if (raw === '' || raw == null || !Number.isFinite(n) || n <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${label} must be a positive amount`);
  }
  return Math.round(n * 100) / 100;
};
const parseDiscount = (raw) => (raw === '' || raw == null || raw === 'null' ? null : parsePrice(raw, 'Discounted price'));
const assertDiscountWithinMrp = (sellingPrice, discountedPrice) => {
  if (discountedPrice != null && discountedPrice > sellingPrice) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Discounted price cannot be more than the selling price (MRP)');
  }
};

// The item's category has to be one of this restaurant's own.
const assertOwnCategory = async (restaurantId, categoryId) => {
  if (!categoryId || !(await Category.exists({ _id: categoryId, restaurantId }))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose one of your own menu categories');
  }
};

// What the owner's item form may change. The update used to $set the whole request body, so
// any field could be written — restaurantId included, moving an item into another
// restaurant's menu.
const EDITABLE_FIELDS = [
  'name', 'description', 'foodType', 'sellingPrice', 'discountedPrice', 'categoryId',
  'subCategoryId', 'prepTime', 'ingredients', 'badges', 'vegVariantId',
];

export const create = asyncHandler(async (req, res) => {
  const { name, description, foodType, sellingPrice, discountedPrice, categoryId,
    subCategoryId, prepTime, ingredients, badges, vegVariantId } = req.body;

  const price = parsePrice(sellingPrice, 'Selling price');
  const discount = parseDiscount(discountedPrice);
  assertDiscountWithinMrp(price, discount);
  await assertOwnCategory(req.restaurant._id, categoryId);

  const itemData = {
    restaurantId: req.restaurant._id,
    categoryId,
    subCategoryId: subCategoryId || undefined,
    name,
    description,
    foodType,
    sellingPrice: price,
    discountedPrice: discount,
    prepTime: prepTime != null ? Number(prepTime) : undefined,
    ingredients: parseArrayField(ingredients),
    badges: parseArrayField(badges),
    vegVariantId: vegVariantId || null,
  };

  let uploadedPublicId;
  if (req.file) {
    try {
      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: req.file.buffer,
        folder: `yulostores/menu/${req.restaurant._id}`,
        publicId: `item_${Date.now()}`,
      });
      itemData.image = secureUrl;
      uploadedPublicId = publicId;
    } catch (uploadErr) {
      throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Image upload failed');
    }
  }

  let item;
  try {
    item = await MenuItem.create(itemData);
  } catch (err) {
    if (uploadedPublicId) await uploadService.deleteImage(uploadedPublicId).catch(() => {});
    throw err;
  }

  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 201, 'Menu item created', { item });
});

export const getOne = asyncHandler(async (req, res) => {
  const item = await MenuItem.findOne({
    _id: req.params.itemId,
    restaurantId: req.restaurant._id,
  }).lean();
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  sendSuccess(res, 200, 'Menu item', { item });
});

export const update = asyncHandler(async (req, res) => {
  const existing = await MenuItem.findOne({
    _id: req.params.itemId,
    restaurantId: req.restaurant._id,
  }).lean();
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');

  const updates = Object.fromEntries(
    EDITABLE_FIELDS.filter((key) => req.body[key] !== undefined).map((key) => [key, req.body[key]])
  );
  if (updates.sellingPrice !== undefined) updates.sellingPrice = parsePrice(updates.sellingPrice, 'Selling price');
  if (updates.discountedPrice !== undefined) updates.discountedPrice = parseDiscount(updates.discountedPrice);
  assertDiscountWithinMrp(
    updates.sellingPrice ?? existing.sellingPrice,
    updates.discountedPrice !== undefined ? updates.discountedPrice : existing.discountedPrice
  );
  if (updates.categoryId !== undefined) await assertOwnCategory(req.restaurant._id, updates.categoryId);
  if (updates.subCategoryId === '') updates.subCategoryId = null;
  if (updates.prepTime != null) updates.prepTime = Number(updates.prepTime);
  if (updates.ingredients != null) updates.ingredients = parseArrayField(updates.ingredients);
  if (updates.badges != null) updates.badges = parseArrayField(updates.badges);
  if (updates.vegVariantId === '') updates.vegVariantId = null;
  let uploadedPublicId;

  if (req.file) {
    try {
      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: req.file.buffer,
        folder: `yulostores/menu/${req.restaurant._id}`,
        publicId: `item_${Date.now()}`,
      });
      updates.image = secureUrl;
      uploadedPublicId = publicId;
    } catch (uploadErr) {
      throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Image upload failed');
    }
  }

  let updated;
  try {
    updated = await MenuItem.findByIdAndUpdate(existing._id, { $set: updates }, { new: true });
  } catch (err) {
    if (uploadedPublicId) await uploadService.deleteImage(uploadedPublicId);
    throw err;
  }

  // Remove old image from Cloudinary after successful DB write
  if (req.file && existing.image) {
    const match = existing.image.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
    if (match) await uploadService.deleteImage(match[1]).catch(() => {});
  }

  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Menu item updated', { item: updated });
});

export const remove = asyncHandler(async (req, res) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.itemId, restaurantId: req.restaurant._id },
    { $set: { isAvailable: false } },
    { new: true }
  );
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Menu item removed', null);
});

export const toggle = asyncHandler(async (req, res) => {
  const item = await MenuItem.findOne({
    _id: req.params.itemId,
    restaurantId: req.restaurant._id,
  });
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');

  item.isAvailable = !item.isAvailable;
  await item.save();
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Availability toggled', { isAvailable: item.isAvailable });
});

export const updateIngredients = asyncHandler(async (req, res) => {
  const { ingredients } = req.body;
  const item = await MenuItem.findOneAndUpdate(
    { _id: req.params.itemId, restaurantId: req.restaurant._id },
    { $set: { ingredients } },
    { new: true }
  );
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  sendSuccess(res, 200, 'Ingredients updated', { item });
});
