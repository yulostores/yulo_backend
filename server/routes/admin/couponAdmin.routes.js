import { Router } from 'express';
import { adminExportLimiter } from '../../middleware/rateLimiter.js';
import {
  list,
  exportCsv,
  listComplimentary,
  assignComplimentary,
  markComplimentaryUsed,
  manualIssue,
  reportSummary,
  reportByCategory,
  reportBySeller,
  reportDemographics,
  reportTrends,
  reportEmployees,
  reportSellers,
  getSettings,
  putSettings,
} from '../../controllers/admin/couponAdmin.controller.js';

// Behind the admin router's authenticate + authorizeRole('admin'). Mounted in routes/admin/index.js
// at /coupons, /coupon-reports and /coupon-settings.

export const couponsRouter = Router();
couponsRouter.get('/', list);
couponsRouter.get('/export.csv', adminExportLimiter, exportCsv);
couponsRouter.get('/complimentary', listComplimentary);
couponsRouter.patch('/complimentary/:id/assign', assignComplimentary);
couponsRouter.patch('/complimentary/:id/mark-used', markComplimentaryUsed);
couponsRouter.post('/issue', manualIssue);

export const couponReportsRouter = Router();
couponReportsRouter.get('/summary', reportSummary);
couponReportsRouter.get('/by-category', reportByCategory);
couponReportsRouter.get('/by-seller', reportBySeller);
couponReportsRouter.get('/demographics', reportDemographics);
couponReportsRouter.get('/trends', reportTrends);
couponReportsRouter.get('/employees', reportEmployees);
couponReportsRouter.get('/sellers', reportSellers);

export const couponSettingsRouter = Router();
couponSettingsRouter.get('/', getSettings);
couponSettingsRouter.put('/', putSettings);
