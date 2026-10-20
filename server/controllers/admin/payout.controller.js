import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as settlementService from '../../services/settlement.service.js';
import * as payoutView from '../../services/payoutView.service.js';
import { FAILURE_REASONS, HOLD_REASONS, STATUSES_FOR_TRANSFER } from '../../utils/payoutStatus.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';
import { localDay, toCsv } from '../../config/settlementExport.config.js';
import * as pdfs from '../../services/pdf/statements.js';
import { logActivity } from '../../services/activityLog.service.js';
import { sendPdf } from '../../utils/sendPdf.js';

// Super admin → Restaurant Payouts (B12; Figma S1–S5, D1–D6, M1–M5). Reads come from
// services/payoutView.service.js; every action is a settlement.service.js lifecycle step
// (conditional write + audit log). The finance router sends Cache-Control: no-store.

const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};

const objectId = z.string().refine(mongoose.isValidObjectId, 'Invalid id');
// A calendar date ("2026-10-12") or a full ISO datetime.
const dateInput = z.string().trim().min(10).max(40);
const reasonOf = (codes) => z.enum(Object.keys(codes));
const optionalNote = z.string().trim().max(500).optional();

// GET /api/admin/finance/payouts/weekly?weekStart= — the Weekly batch tab (default: last week).
export const weekly = asyncHandler(async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: z.coerce.date().optional() }), req.query);
  sendSuccess(res, 200, 'Weekly batch', await payoutView.weeklyBatch({ weekStart }));
});

const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// GET /api/admin/finance/payouts/clearance?restaurantId&page&limit — the Clearance queue tab.
export const clearance = asyncHandler(async (req, res) => {
  const q = parse(z.object({ restaurantId: objectId.optional(), ...pageQuery }), req.query);
  sendSuccess(res, 200, 'Clearance queue', await payoutView.clearanceQueue(q));
});

const historySchema = z.object({
  restaurantId: objectId.optional(),
  transferStatus: z.enum(Object.keys(STATUSES_FOR_TRANSFER)).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

// GET /api/admin/finance/payouts/history?restaurantId&transferStatus&from&to&page&limit
export const history = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Payout history', await payoutView.payoutHistory(parse(historySchema, req.query)));
});

const HISTORY_COLUMNS = [
  { header: 'Restaurant', value: (r) => r.restaurant?.name ?? '' },
  { header: 'Statement start', value: (r, c) => localDay(r.periodStart, c.timezone) },
  { header: 'Statement end', value: (r, c) => localDay(r.periodEnd, c.timezone) },
  { header: 'Net payout (₹)', value: (r) => (r.netPayoutPaise / 100).toFixed(2) },
  { header: 'Eligibility', value: (r) => r.eligibility },
  { header: 'Bank transfer', value: (r) => r.transfer.label },
  { header: 'Transfer date', value: (r, c) => (r.transferDate ? localDay(r.transferDate, c.timezone) : '') },
  { header: 'Bank reference', value: (r) => r.bankReference ?? '' },
];

// GET /api/admin/finance/payouts/history/export — the filtered history (every page) as CSV.
export const historyExport = asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = parse(historySchema, req.query);
  const rows = await payoutView.payoutHistoryForExport(filters);
  const { timezone } = (await getActiveSettings()).settlementCycle;
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="payout-history-${localDay(new Date(), timezone)}.csv"`);
  res.send(toCsv(HISTORY_COLUMNS, rows, { timezone }));
});

// GET /api/admin/finance/payouts/:id — one payout's detail (D1–D6).
export const detail = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Payout', await payoutView.payoutDetail(req.params.id));
});

// GET /api/admin/finance/payouts/:id/pdf — the statement with the platform figures (Razorpay
// fees, Yulo margin, rider pay, the hold's internal note); audit-logged like the CSV downloads.
export const statementPdf = asyncHandler(async (req, res) => {
  const pdf = await pdfs.adminStatementPdf(req.params.id);
  await logActivity({ adminId: req.user._id, action: 'payout.statement_pdf', targetType: 'settlement', targetId: req.params.id, metadata: { restaurantId: pdf.restaurantId } });
  sendPdf(res, pdf);
});

// GET /api/admin/finance/payouts/:id/receipt.pdf — the paid payout's receipt (409 NOT_PAID before).
export const receiptPdf = asyncHandler(async (req, res) => {
  const pdf = await pdfs.payoutReceiptPdf(req.params.id);
  await logActivity({ adminId: req.user._id, action: 'payout.receipt_pdf', targetType: 'settlement', targetId: req.params.id, metadata: { restaurantId: pdf.restaurantId } });
  sendPdf(res, pdf);
});

// GET /api/admin/finance/payouts/options — reason codes for the modals + the default release date.
export const options = asyncHandler(async (_req, res) => {
  const settings = await getActiveSettings();
  sendSuccess(res, 200, 'Payout options', {
    holdReasons: HOLD_REASONS,
    failureReasons: FAILURE_REASONS,
    payoutDayOfWeek: settings.payoutDayOfWeek,
    defaultReleaseDate: await settlementService.defaultReleaseDay(),
  });
});

const respond = (res, message, settlement) => sendSuccess(res, 200, message, { settlement });

// PATCH …/:id/schedule — body { scheduledFor? } (M1). Without a date: the next payout day.
export const schedule = asyncHandler(async (req, res) => {
  const { scheduledFor } = parse(z.object({ scheduledFor: dateInput.optional() }), req.body);
  respond(res, 'Payout scheduled', await settlementService.scheduleSettlement(req.params.id, { scheduledFor }, req.user._id));
});

// PATCH …/:id/schedule-date — body { scheduledFor } (Change date).
export const changeDate = asyncHandler(async (req, res) => {
  const { scheduledFor } = parse(z.object({ scheduledFor: dateInput }), req.body);
  respond(res, 'Release date changed', await settlementService.changeScheduledDate(req.params.id, { scheduledFor }, req.user._id));
});

// PATCH …/:id/reschedule — body { scheduledFor? } (a failed payout).
export const reschedule = asyncHandler(async (req, res) => {
  const { scheduledFor } = parse(z.object({ scheduledFor: dateInput.optional() }), req.body);
  respond(res, 'Payout rescheduled', await settlementService.rescheduleSettlement(req.params.id, { scheduledFor }, req.user._id));
});

// PATCH …/:id/release — body { expectedNetPaise? } (M2: the amount the admin confirmed).
export const release = asyncHandler(async (req, res) => {
  const { expectedNetPaise } = parse(z.object({ expectedNetPaise: z.number().int().positive().optional() }), req.body);
  respond(res, 'Payout released', await settlementService.releaseSettlement(req.params.id, req.user._id, { expectedNetPaise }));
});

// PATCH …/:id/mark-paid — body { bankReference, creditedAt? } (M3).
export const markPaid = asyncHandler(async (req, res) => {
  const body = parse(
    z.object({
      bankReference: z.string().trim().min(4, 'Enter the bank reference to continue.').max(40),
      creditedAt: dateInput.optional(),
    }),
    req.body
  );
  respond(res, 'Payout marked paid', await settlementService.recordPayoutPaid(req.params.id, body, req.user._id));
});

// PATCH …/:id/mark-failed — body { reason, note? } (M4).
export const markFailed = asyncHandler(async (req, res) => {
  const body = parse(z.object({ reason: reasonOf(FAILURE_REASONS), note: optionalNote }), req.body);
  respond(res, 'Payout marked failed', await settlementService.recordPayoutFailed(req.params.id, body, req.user._id));
});

// PATCH …/:id/hold — body { reason, note? } (M5). The note is staff-only.
export const hold = asyncHandler(async (req, res) => {
  const body = parse(z.object({ reason: reasonOf(HOLD_REASONS), note: optionalNote }), req.body);
  respond(res, 'Payout on hold', await settlementService.holdSettlement(req.params.id, req.user._id, body));
});

// PATCH …/:id/hold-reason — body { reason, note? } (Update reason).
export const holdReason = asyncHandler(async (req, res) => {
  const body = parse(z.object({ reason: reasonOf(HOLD_REASONS), note: optionalNote }), req.body);
  respond(res, 'Hold reason updated', await settlementService.updateHoldReason(req.params.id, req.user._id, body));
});

// PATCH …/:id/release-hold — back to eligible, not scheduled.
export const releaseHold = asyncHandler(async (req, res) => {
  respond(res, 'Hold released', await settlementService.unholdSettlement(req.params.id, req.user._id));
});
