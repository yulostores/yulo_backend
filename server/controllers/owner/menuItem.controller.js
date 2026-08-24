import MenuItem from '../../models/MenuItem.js';
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

export const create = asyncHandler(async (req, res) => {
  const { name, description, foodType, sellingPrice, discountedPrice, categoryId,
    subCategoryId, prepTime, ingredients, badges, vegVariantId } = req.body;

  const itemData = {
    restaurantId: req.restaurant._id,
    categoryId,
    subCategoryId: subCategoryId || undefined,
    name,
    description,
    foodType,
    sellingPrice: Number(sellingPrice),
    discountedPrice: discountedPrice != null ? Number(discountedPrice) : null,
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

  const updates = { ...req.body };
  if (updates.sellingPrice != null) updates.sellingPrice = Number(updates.sellingPrice);
  if (updates.discountedPrice != null) updates.discountedPrice = Number(updates.discountedPrice);
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
