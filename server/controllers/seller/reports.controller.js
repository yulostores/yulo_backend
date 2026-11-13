import * as reports from '../../services/sellerReports.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — dashboard and reports (services/sellerReports.service.js). Owner and manager;
// approved sellers only (routes/seller/index.js). Every coupon row goes through
// toSellerCouponView: masked name, gender, age band — never a phone, customer id or code.

const parseOr400 = (schema, input) => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid filter', flat);
  }
  return parsed.data;
};
const filters = (req) => parseOr400(reports.reportFilterSchema, { from: req.query.from, to: req.query.to, status: req.query.status });

/** GET /api/seller/dashboard */
export const dashboard = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Dashboard', await reports.dashboard(req.seller.sellerId));
});

/** GET /api/seller/reports/demographics?from&to&status */
export const demographics = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Demographics', await reports.demographics(req.seller.sellerId, filters(req)));
});

/** GET /api/seller/reports/trends?interval=day|week|month&from&to&status */
export const trends = asyncHandler(async (req, res) => {
  const { interval } = parseOr400(reports.trendsQuerySchema, { interval: req.query.interval });
  sendSuccess(res, 200, 'Trends', await reports.trends(req.seller.sellerId, { interval, ...filters(req) }));
});

/** GET /api/seller/reports/coupons?from&to&status&page&limit */
export const coupons = asyncHandler(async (req, res) => {
  const page = parseOr400(reports.pageSchema, { page: req.query.page, limit: req.query.limit });
  sendSuccess(res, 200, 'Coupons', await reports.couponList(req.seller.sellerId, filters(req), page));
});

/** GET /api/seller/reports/coupons.csv?from&to&status */
export const couponsCsv = asyncHandler(async (req, res) => {
  const csv = await reports.couponsCsv(req.seller.sellerId, filters(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="coupons.csv"');
  res.setHeader('Cache-Control', 'no-store');
  // BOM so Excel opens the UTF-8 (₹, names) correctly.
  res.status(200).send(`﻿${csv}`);
});
