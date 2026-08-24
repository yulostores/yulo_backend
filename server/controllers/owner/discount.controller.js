import { z } from 'zod';
import Discount from '../../models/Discount.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Base fields without refine — extend first, then refine per branch (Zod v4 requirement)
const baseFields = {
  offerName: z.string().min(1),
  code: z.string().optional(),
  applicableTo: z.enum(['dine_in', 'delivery', 'both']).default('both'),
  minimumOrderValue: z.number().min(0).default(0),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  applicableTableNumbers: z.array(z.string()).optional(),
  applicableCategories: z.array(z.string()).optional(),
  applicableSubCategories: z.array(z.string()).optional(),
  applicableItems: z.array(z.string()).optional(),
  isFeatured: z.boolean().optional().default(false),
};

const dateRefine = (d) => d.endDate > d.startDate;
const dateRefineOpts = { message: 'endDate must be after startDate', path: ['endDate'] };

const discountSchema = z.discriminatedUnion('type', [
  z.object({ ...baseFields, type: z.literal('percentage'), percentage: z.number().min(1).max(100) })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('flat_amount'), flatAmount: z.number().positive() })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('free_item'), freeItemId: z.string().min(1), freeItemName: z.string().optional() })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('tablewise'), flatAmount: z.number().positive(), applicableTableNumbers: z.array(z.string()).min(1) })
    .refine(dateRefine, dateRefineOpts),
]);

const validate = (body) => {
  const result = discountSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid discount data', result.error.flatten());
  }
  return result.data;
};

export const list = asyncHandler(async (req, res) => {
  const discounts = await Discount.find({ restaurantId: req.restaurant._id }).lean();
  sendSuccess(res, 200, 'Discounts', { discounts });
});

export const create = asyncHandler(async (req, res) => {
  const data = validate(req.body);
  const discount = await Discount.create({ ...data, restaurantId: req.restaurant._id });
  sendSuccess(res, 201, 'Discount created', { discount });
});

export const update = asyncHandler(async (req, res) => {
  const data = validate(req.body);
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.dId, restaurantId: req.restaurant._id },
    { $set: data },
    { new: true }
  );
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found');
  sendSuccess(res, 200, 'Discount updated', { discount });
});

export const remove = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndDelete({
    _id: req.params.dId,
    restaurantId: req.restaurant._id,
  });
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found');
  sendSuccess(res, 200, 'Discount deleted', null);
});

export const publish = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.dId, restaurantId: req.restaurant._id, status: 'draft' },
    { $set: { status: 'active' } },
    { new: true }
  );
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found or already active');
  sendSuccess(res, 200, 'Discount published', { discount });
});

export const draft = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.dId, restaurantId: req.restaurant._id, status: 'active' },
    { $set: { status: 'draft' } },
    { new: true }
  );
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found or already draft');
  sendSuccess(res, 200, 'Discount reverted to draft', { discount });
});
