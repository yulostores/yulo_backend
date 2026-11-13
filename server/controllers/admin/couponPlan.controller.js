import { z } from 'zod';
import CouponPlan from '../../models/CouponPlan.js';
import { planView } from '../../services/sellerSubscription.service.js';
import { logActivity } from '../../services/activityLog.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { toPaise } from '../../utils/money.js';

// Super admin — the coupon partner plans on sale. An edit applies to purchases made after it:
// every subscription keeps a snapshot of the plan it bought (models/SellerSubscription.js).
// Prices are entered in rupees, GST-exclusive, and stored in paise.

/** GET /api/admin/coupon-plans — every plan, on sale or not, with base / GST / total. */
export const list = asyncHandler(async (req, res) => {
  const plans = await CouponPlan.find().sort({ sortOrder: 1, basePricePaise: 1 }).lean();
  sendSuccess(res, 200, 'Coupon plans', {
    plans: plans.map((p) => ({ ...planView(p), complimentaryCount: p.complimentaryCount })),
  });
});

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(40),
    basePriceRupees: z.number().positive().max(10_000_000),
    gstPercent: z.number().min(0).max(28),
    couponAllocation: z.number().int().min(1).max(1_000_000),
    complimentaryCount: z.number().int().min(0).max(100),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(-1000).max(1000),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** PUT /api/admin/coupon-plans/:key  (any subset of the fields) */
export const update = asyncHandler(async (req, res) => {
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid plan', parsed.error.flatten());
  const { basePriceRupees, ...rest } = parsed.data;
  const set = { ...rest };
  if (basePriceRupees !== undefined) set.basePricePaise = toPaise(basePriceRupees);

  const before = await CouponPlan.findOne({ key: req.params.key }).lean();
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Plan not found');
  const plan = await CouponPlan.findOneAndUpdate({ _id: before._id }, { $set: set }, { new: true, runValidators: true }).lean();

  const changes = Object.keys(set)
    .filter((k) => before[k] !== plan[k])
    .map((field) => ({ field, from: before[field] ?? null, to: plan[field] }));
  await logActivity({ adminId: req.user._id, action: 'COUPON_PLAN_UPDATED', targetType: 'coupon_plan', targetId: plan._id, metadata: { key: plan.key, changes } });

  sendSuccess(res, 200, 'Plan saved — applies to new purchases', { plan: { ...planView(plan), complimentaryCount: plan.complimentaryCount } });
});
