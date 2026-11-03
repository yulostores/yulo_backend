import { z } from 'zod';
import Category from '../../models/Category.js';
import SubCategory from '../../models/SubCategory.js';
import * as menuService from '../../services/menu.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Category and sub-category bodies. Updates used to `$set` the request body as sent — a
// caller could move a category into another restaurant (`restaurantId`) or blank its name.
const NAME_MAX = 60;
const nameSchema = z.string({ error: 'Add a name' }).trim().min(1, 'Add a name').max(NAME_MAX, `Name must be at most ${NAME_MAX} characters`);
const orderSchema = z.number().int().min(0).max(10000);
const createSchema = z.object({ name: nameSchema, displayOrder: orderSchema.optional() });
const updateSchema = z.object({ name: nameSchema.optional(), displayOrder: orderSchema.optional() }).strict();

const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const flat = result.error.flatten();
    const first = Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid details';
    throw new ApiError(400, 'VALIDATION_ERROR', first, flat);
  }
  return result.data;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Two categories called "Main Course" split one menu section in two for guests.
const assertNameFree = async (Model, filter, name, exceptId) => {
  const clash = await Model.exists({
    ...filter,
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    ...(exceptId && { _id: { $ne: exceptId } }),
  });
  if (clash) throw new ApiError(409, 'DUPLICATE_KEY', `"${name}" already exists`);
};

// Sub-category routes are addressed by category id alone; without this an owner could list,
// add to, edit or delete another restaurant's sub-categories by naming its category.
const ownCategory = async (req) => {
  const category = await Category.exists({ _id: req.params.cId, restaurantId: req.restaurant._id });
  if (!category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
};

export const listCategories = asyncHandler(async (req, res) => {
  const categories = await Category.find({ restaurantId: req.restaurant._id })
    .sort({ displayOrder: 1 })
    .lean();
  sendSuccess(res, 200, 'Categories', { categories });
});

export const createCategory = asyncHandler(async (req, res) => {
  const { name, displayOrder } = parse(createSchema, req.body);
  await assertNameFree(Category, { restaurantId: req.restaurant._id }, name);
  const category = await Category.create({
    restaurantId: req.restaurant._id,
    name,
    displayOrder: displayOrder ?? 0,
  });
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 201, 'Category created', { category });
});

export const updateCategory = asyncHandler(async (req, res) => {
  const updates = parse(updateSchema, req.body);
  if (updates.name) await assertNameFree(Category, { restaurantId: req.restaurant._id }, updates.name, req.params.cId);
  const category = await Category.findOneAndUpdate(
    { _id: req.params.cId, restaurantId: req.restaurant._id },
    { $set: updates },
    { new: true }
  );
  if (!category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Category updated', { category });
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findOneAndDelete({
    _id: req.params.cId,
    restaurantId: req.restaurant._id,
  });
  if (!category) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Category deleted', null);
});

export const listSubCategories = asyncHandler(async (req, res) => {
  await ownCategory(req);
  const subs = await SubCategory.find({ categoryId: req.params.cId })
    .sort({ displayOrder: 1 })
    .lean();
  sendSuccess(res, 200, 'Sub-categories', { subCategories: subs });
});

export const createSubCategory = asyncHandler(async (req, res) => {
  await ownCategory(req);
  const { name, displayOrder } = parse(createSchema, req.body);
  await assertNameFree(SubCategory, { categoryId: req.params.cId }, name);
  const sub = await SubCategory.create({
    restaurantId: req.restaurant._id,
    categoryId: req.params.cId,
    name,
    displayOrder: displayOrder ?? 0,
  });
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 201, 'Sub-category created', { subCategory: sub });
});

export const updateSubCategory = asyncHandler(async (req, res) => {
  await ownCategory(req);
  const updates = parse(updateSchema, req.body);
  if (updates.name) await assertNameFree(SubCategory, { categoryId: req.params.cId }, updates.name, req.params.sId);
  const sub = await SubCategory.findOneAndUpdate(
    { _id: req.params.sId, categoryId: req.params.cId },
    { $set: updates },
    { new: true }
  );
  if (!sub) throw new ApiError(404, 'NOT_FOUND', 'Sub-category not found');
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Sub-category updated', { subCategory: sub });
});

export const deleteSubCategory = asyncHandler(async (req, res) => {
  await ownCategory(req);
  const sub = await SubCategory.findOneAndDelete({
    _id: req.params.sId,
    categoryId: req.params.cId,
  });
  if (!sub) throw new ApiError(404, 'NOT_FOUND', 'Sub-category not found');
  await menuService.invalidateMenu(req.restaurant._id);
  sendSuccess(res, 200, 'Sub-category deleted', null);
});
