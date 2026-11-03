import { z } from 'zod';
import LoyaltyProgram from '../../models/LoyaltyProgram.js';
import LoyaltyMilestone from '../../models/LoyaltyMilestone.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Bodies are checked and limited to the fields an owner sets. Milestone updates used to `$set`
// the request body as sent — `restaurantId` and `programId` included — and the program took
// any number (negative points per rupee).
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const money = z.number().min(0).max(100000);
const programSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    isActive: z.boolean().optional(),
    pointsPerRupee: z.number().min(0).max(100).optional(),
  })
  .strict();
const milestoneFields = {
  offerName: z.string().trim().min(1).max(100),
  rewardType: z.enum(['free_item', 'flat_amount', 'percentage', 'tablewise']),
  freeItemId: objectId.nullish(),
  freeItemName: z.string().trim().max(100).nullish(),
  rewardValue: money.nullish(),
  minimumOrderValue: money.optional(),
  description: z.string().trim().max(300).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
};
const milestoneCreateSchema = z.object(milestoneFields).strict();
const milestoneUpdateSchema = z.object(milestoneFields).partial().strict();

const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid loyalty details', result.error.flatten());
  const data = result.data;
  if (data.startDate && data.endDate && data.endDate <= data.startDate) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'endDate must be after startDate');
  }
  return data;
};

const getOrCreateProgram = (restaurantId) =>
  LoyaltyProgram.findOneAndUpdate(
    { restaurantId },
    { $setOnInsert: { restaurantId } },
    { upsert: true, new: true }
  );

export const getProgram = asyncHandler(async (req, res) => {
  const program = await getOrCreateProgram(req.restaurant._id);
  sendSuccess(res, 200, 'Loyalty program', { program });
});

export const updateProgram = asyncHandler(async (req, res) => {
  const { name, isActive, pointsPerRupee } = parse(programSchema, req.body);
  const program = await LoyaltyProgram.findOneAndUpdate(
    { restaurantId: req.restaurant._id },
    { $set: { name, isActive, pointsPerRupee } },
    { upsert: true, new: true }
  );
  sendSuccess(res, 200, 'Loyalty program updated', { program });
});

export const listMilestones = asyncHandler(async (req, res) => {
  const milestones = await LoyaltyMilestone.find({
    restaurantId: req.restaurant._id,
  }).lean();
  sendSuccess(res, 200, 'Milestones', { milestones });
});

export const createMilestone = asyncHandler(async (req, res) => {
  const program = await getOrCreateProgram(req.restaurant._id);
  const milestone = await LoyaltyMilestone.create({
    ...parse(milestoneCreateSchema, req.body),
    restaurantId: req.restaurant._id,
    programId: program._id,
  });
  sendSuccess(res, 201, 'Milestone created', { milestone });
});

export const updateMilestone = asyncHandler(async (req, res) => {
  const milestone = await LoyaltyMilestone.findOneAndUpdate(
    { _id: req.params.mId, restaurantId: req.restaurant._id },
    { $set: parse(milestoneUpdateSchema, req.body) },
    { new: true }
  );
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  sendSuccess(res, 200, 'Milestone updated', { milestone });
});

export const deleteMilestone = asyncHandler(async (req, res) => {
  const milestone = await LoyaltyMilestone.findOneAndDelete({
    _id: req.params.mId,
    restaurantId: req.restaurant._id,
  });
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  sendSuccess(res, 200, 'Milestone deleted', null);
});
