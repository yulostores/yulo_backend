import { z } from 'zod';
import * as adminCoupons from '../../services/adminCoupon.service.js';
import * as reports from '../../services/adminCouponReports.service.js';
import {
  getActiveCouponSettings,
  listCouponSettingsVersions,
  createCouponSettingsVersion,
  COUPON_SETTINGS_UNITS,
} from '../../services/couponSettings.service.js';
import { logActivity } from '../../services/activityLog.service.js';
import { csvCell } from '../../utils/csv.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';

// Super admin — coupons (list, CSV export, complimentary, manual issue), coupon reports and the
// coupon settings. Behind the admin router's authenticate + authorizeRole('admin').

// ── Coupons ───────────────────────────────────────────────────────────────────

/** GET /api/admin/coupons */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupons', await adminCoupons.listCoupons(adminCoupons.parseListQuery(req.query)));
});

/**
 * GET /api/admin/coupons/export.csv — every row matching the list's filters, streamed. Logged
 * (with the filters) before the first byte, so even an abandoned download leaves a record.
 */
export const exportCsv = asyncHandler(async (req, res) => {
  const filters = adminCoupons.parseFilterQuery(req.query);
  await logActivity({ adminId: req.user._id, action: 'COUPONS_EXPORTED', targetType: 'coupon', metadata: { filters } });

  const day = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="coupons-${day}.csv"`);
  res.status(200);
  res.write('﻿'); // Excel reads the file as UTF-8 (₹, names)

  try {
    for await (const chunk of adminCoupons.exportCsvChunks(filters, csvCell)) {
      if (res.destroyed) return; // the admin cancelled the download
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (err) {
    // Headers are gone; all we can do is cut the file short so it can't pass for complete.
    logger.error({ err }, 'Coupon export failed mid-stream');
    res.destroy(err);
  }
});

/** GET /api/admin/coupons/complimentary?seller&subscription&assigned&status */
export const listComplimentary = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Complimentary coupons', await adminCoupons.listComplimentary(req.query));
});

/** PATCH /api/admin/coupons/complimentary/:id/assign { name, phone, note? } */
export const assignComplimentary = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon assigned', { coupon: await adminCoupons.assignComplimentary(req.params.id, req.user._id, req.body) });
});

/** PATCH /api/admin/coupons/complimentary/:id/mark-used */
export const markComplimentaryUsed = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon marked used', { coupon: await adminCoupons.markComplimentaryUsed(req.params.id, req.user._id) });
});

/** POST /api/admin/coupons/issue { phone, sellerId, offerId?, note?, requestId? } */
export const manualIssue = asyncHandler(async (req, res) => {
  const { coupon, duplicate } = await adminCoupons.manualIssue(req.user._id, req.body);
  sendSuccess(res, duplicate ? 200 : 201, duplicate ? 'Already issued' : 'Coupon issued', { coupon, duplicate });
});

// ── Reports ───────────────────────────────────────────────────────────────────

const report = (fn) => asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon report', await fn(reports.parseReportFilters(req.query)));
});

export const reportSummary = report(reports.summary);
export const reportByCategory = report(reports.byCategory);
export const reportBySeller = report(reports.bySeller);
export const reportDemographics = report(reports.demographics);
export const reportEmployees = report(reports.employees);
export const reportSellers = report(reports.sellers);

/** GET /api/admin/coupon-reports/trends?interval=day|week|month&status&from&to&category&seller */
export const reportTrends = asyncHandler(async (req, res) => {
  const opts = reports.adminTrendsSchema.safeParse({ interval: req.query.interval, status: req.query.status });
  if (!opts.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid interval or status', opts.error.flatten());
  sendSuccess(res, 200, 'Coupon report', await reports.trends(reports.parseReportFilters(req.query), opts.data));
});

// ── Settings ──────────────────────────────────────────────────────────────────

/** GET /api/admin/coupon-settings — the rules in force, every version, and the units. */
export const getSettings = asyncHandler(async (_req, res) => {
  // In order: the first read seeds version 1 on an empty database, and the history must include it.
  const active = await getActiveCouponSettings();
  const versions = await listCouponSettingsVersions();
  sendSuccess(res, 200, 'Coupon settings', { active, versions, units: COUPON_SETTINGS_UNITS });
});

const settingsBody = z.object({ note: z.string().trim().max(500).optional() }).passthrough();

/** PUT /api/admin/coupon-settings { ...changed fields, note? } — a new version, in force at once. */
export const putSettings = asyncHandler(async (req, res) => {
  const parsed = settingsBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid coupon settings', parsed.error.flatten());
  const { note = '', ...patch } = parsed.data;
  const { version, changes } = await createCouponSettingsVersion({ patch, note }, req.user._id);
  await logActivity({
    adminId: req.user._id,
    action: 'COUPON_SETTINGS_UPDATED',
    targetType: 'coupon_settings',
    targetId: version._id,
    metadata: { version: version.version, changes, note },
  });
  sendSuccess(res, 200, 'Coupon settings saved', { version, changes });
});
