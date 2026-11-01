import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';
import { weekBounds } from '../../utils/week.js';
import { logActivity } from '../../services/activityLog.service.js';
import * as moneyReport from '../../services/moneyReport.service.js';
import { markPayoutPaid } from '../../services/payout.service.js';

// The super admin's Orders & Money page and Weekly Report (services/moneyReport.service.js).

const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};
const objectId = z.string().refine(mongoose.isValidObjectId, 'Invalid id');

const moneySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  weekStart: z.coerce.date().optional(),
  type: z.enum(['delivery', 'takeaway', 'dine_in']).optional(),
  restaurantId: objectId.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /api/admin/finance/money?weekStart | from&to, type, restaurantId, page, limit
// Default: the current week (Mon–Sun, settlement time zone).
export const money = asyncHandler(async (req, res) => {
  const q = parse(moneySchema, req.query);
  let { from, to } = q;
  if (!from || !to) {
    const { settlementCycle } = await getActiveSettings();
    const b = weekBounds(q.weekStart ?? new Date(), settlementCycle);
    from = b.start;
    to = b.end;
  }
  if (from > to) throw new ApiError(400, 'VALIDATION_ERROR', '"from" must be before "to"');
  sendSuccess(res, 200, 'Orders and money', await moneyReport.moneyRows({ ...q, from, to }));
});

// GET /api/admin/finance/weekly-report?weekStart — default: the last week that ended.
export const weekly = asyncHandler(async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: z.coerce.date().optional() }), req.query);
  sendSuccess(res, 200, 'Weekly report', await moneyReport.weeklyReport({ weekStart }));
});

const paySchema = z.object({
  reference: z.string().trim().min(4).max(60),
  paidOn: z.coerce.date().optional(),
  expectedNetPaise: z.number().int().optional(),
});

// POST /api/admin/finance/weekly-report/restaurants/:settlementId/mark-paid
export const payRestaurant = asyncHandler(async (req, res) => {
  const body = parse(paySchema, req.body);
  const settlement = await moneyReport.payRestaurantFromReport(req.params.settlementId, body, req.user._id);
  sendSuccess(res, 200, 'Restaurant payout marked paid', { settlement });
});

// POST /api/admin/finance/weekly-report/riders/:payoutId/mark-paid
export const payRider = asyncHandler(async (req, res) => {
  const body = parse(paySchema, req.body);
  const payout = await markPayoutPaid(req.params.payoutId, { reference: body.reference, paidAt: body.paidOn, adminId: req.user._id });
  await logActivity({
    adminId: req.user._id,
    action: 'rider_payout.mark_paid',
    targetType: 'delivery_partner',
    targetId: payout.partnerId,
    metadata: { payoutId: payout._id, netPayable: payout.netPayable, reference: payout.paymentReference, periodStart: payout.periodStart },
  });
  sendSuccess(res, 200, 'Rider payout marked paid', { payout });
});

// GET /api/admin/finance/payouts/live?weekStart — the Payouts page's Live tab (default: this week).
export const live = asyncHandler(async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: z.coerce.date().optional() }), req.query);
  sendSuccess(res, 200, 'Live payouts', await moneyReport.liveWeek({ weekStart }));
});
