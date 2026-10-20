import mongoose from 'mongoose';
import { z } from 'zod';
import RestaurantSettlement from '../../models/RestaurantSettlement.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as settlementService from '../../services/settlement.service.js';
import { SETTLEMENT_EXPORT_COLUMNS, ENTRY_EXPORT_COLUMNS, toCsv } from '../../config/settlementExport.config.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';
import { weekBounds } from '../../utils/week.js';
import { localDay } from '../../config/settlementExport.config.js';
import { logActivity } from '../../services/activityLog.service.js';

const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};

const objectId = z.string().refine(mongoose.isValidObjectId, 'Invalid id');

const listSchema = z.object({
  restaurantId: objectId.optional(),
  status: z.enum(['draft', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'carried_forward']).optional(),
  weekStart: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// GET /api/admin/finance/settlements?restaurantId&status&weekStart&page&limit
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Settlements', await settlementService.listSettlements(parse(listSchema, req.query)));
});

// POST /api/admin/finance/settlements/generate — body { weekStart: any date in the week }.
// Idempotent: re-running a week tops up its open settlements, never touches approved/paid ones.
export const generate = asyncHandler(async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: z.coerce.date() }), req.body);
  const result = await settlementService.generateWeeklySettlements(weekStart);
  // The scheduled Monday run isn't logged here (no admin); an admin's run is.
  await logActivity({
    adminId: req.user._id,
    action: 'settlement.generate',
    targetType: 'settlement',
    targetId: null,
    metadata: {
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      count: result.settlements.length,
      settlementIds: result.settlements.map((x) => x._id),
    },
  });
  sendSuccess(res, 200, 'Settlements generated', {
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    count: result.settlements.length,
    settlements: result.settlements,
  });
});

// GET /api/admin/finance/settlements/:id — every row, each with its full breakdown (Razorpay fee,
// Yulo margin, rider pay included), plus those platform totals.
export const detail = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Settlement', await settlementService.getSettlementDetail(req.params.id));
});

// PATCH …/:id/approve — body { scheduledFor? }. Since B12 approving IS scheduling: without a
// date it is scheduled for the next payout day. The payout screens use …/payouts/:id/schedule.
export const approve = asyncHandler(async (req, res) => {
  const { scheduledFor } = parse(z.object({ scheduledFor: z.string().trim().min(10).max(40).optional() }), req.body);
  sendSuccess(res, 200, 'Settlement approved', {
    settlement: await settlementService.approveSettlement(req.params.id, req.user._id, { scheduledFor }),
  });
});

// PATCH …/:id/hold — body { note, reason? } (reason defaults to 'other'; the note is staff-only).
export const hold = asyncHandler(async (req, res) => {
  const { note, reason } = parse(
    z.object({
      note: z.string().trim().min(3).max(300),
      reason: z.enum(['dispute_review', 'bank_details_review', 'compliance_review', 'other']).default('other'),
    }),
    req.body
  );
  sendSuccess(res, 200, 'Settlement on hold', {
    settlement: await settlementService.holdSettlement(req.params.id, req.user._id, { reason, note }),
  });
});

export const unhold = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Hold released', {
    settlement: await settlementService.unholdSettlement(req.params.id, req.user._id),
  });
});

// PATCH …/:id/mark-paid — body { utr } — paid outside the payout provider.
export const markPaid = asyncHandler(async (req, res) => {
  const { utr } = parse(z.object({ utr: z.string().trim().min(4).max(40) }), req.body);
  sendSuccess(res, 200, 'Settlement marked paid', {
    settlement: await settlementService.markPaidManually(req.params.id, utr, req.user._id),
  });
});

// POST …/adjustments — body { restaurantId, amountPaise, direction, kind?, note }.
export const adjust = asyncHandler(async (req, res) => {
  const body = parse(
    z.object({
      restaurantId: objectId,
      amountPaise: z.number().int().positive().max(settlementService.MAX_ADJUSTMENT_PAISE),
      direction: z.enum(['credit', 'debit']),
      kind: z.enum(['correction', 'penalty']).default('correction'),
      note: z.string().trim().min(3).max(300),
    }),
    req.body
  );
  const entry = await settlementService.addAdjustment({ ...body, adminId: req.user._id });
  sendSuccess(res, 201, 'Adjustment recorded', { entry });
});

const sendCsv = (res, filename, csv) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
};

// GET …/export?weekStart= — every restaurant's settlement for the week, one row each.
export const exportWeek = asyncHandler(async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: z.coerce.date() }), req.query);
  const { settlementCycle } = await getActiveSettings();
  const { start } = weekBounds(weekStart, settlementCycle);
  const settlements = await RestaurantSettlement.find({ periodStart: start })
    .populate('restaurantId', 'name')
    .sort({ 'totals.netPayable': -1 })
    .lean();
  sendCsv(
    res,
    `settlements-${localDay(start, settlementCycle.timezone)}.csv`,
    toCsv(SETTLEMENT_EXPORT_COLUMNS, settlements, { timezone: settlementCycle.timezone })
  );
});

// GET …/:id/export — one settlement's rows (the per-order statement), admin columns included.
export const exportOne = asyncHandler(async (req, res) => {
  const { settlement, entries } = await settlementService.getSettlementDetail(req.params.id);
  const { timezone } = (await getActiveSettings()).settlementCycle;
  sendCsv(
    res,
    `settlement-${String(settlement._id)}.csv`,
    toCsv(ENTRY_EXPORT_COLUMNS, entries, { audience: 'admin', timezone })
  );
});
