import { Router } from 'express';
import {
  overview,
  revenueTrend,
  earningsVsSpending,
  restaurantRevenue,
} from '../../controllers/admin/finance.controller.js';
import { getSettings, createSettingsVersion } from '../../controllers/admin/financeSettings.controller.js';
import { orderBreakdown, billBreakdown } from '../../controllers/admin/financeBreakdown.controller.js';
import { listRefunds, retryRefund } from '../../controllers/admin/refund.controller.js';
import * as settlements from '../../controllers/admin/settlement.controller.js';
import * as payoutBatches from '../../controllers/admin/payoutBatch.controller.js';
import * as payouts from '../../controllers/admin/payout.controller.js';
import * as moneyReport from '../../controllers/admin/moneyReport.controller.js';
import * as restaurantPayouts from '../../controllers/admin/restaurantPayouts.controller.js';
import RestaurantSettlement from '../../models/RestaurantSettlement.js';
import { isAnytimeMode } from '../../config/payoutMode.js';
import { ApiError } from '../../utils/ApiError.js';

const router = Router();

// Restaurants are paid any day now (config/payoutMode.js): the weekly statement's own ways of
// paying are refused, so the same money can't also go out through a weekly statement. Recording
// the result of a transfer that was already released to the bank stays allowed.
const weeklyRetired = (_req, _res, next) => {
  if (!isAnytimeMode()) return next();
  return next(new ApiError(409, 'WEEKLY_PAYOUTS_RETIRED', 'Weekly payouts are retired — pay restaurants from Restaurant Payouts › Balances'));
};
const onlyIfReleased = async (req, _res, next) => {
  const id = req.params.id ?? req.params.settlementId;
  if (!isAnytimeMode()) return next();
  try {
    const s = await RestaurantSettlement.findById(id).select('status').lean();
    if (s && s.status !== 'processing') {
      return next(new ApiError(409, 'WEEKLY_PAYOUTS_RETIRED', 'Weekly payouts are retired — pay restaurants from Restaurant Payouts › Balances'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

// Per-restaurant money, Razorpay fees, Yulo's margin, UTRs: never stored by a browser or proxy.
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/overview', overview);
router.get('/revenue-trend', revenueTrend);
router.get('/earnings-vs-spending', earningsVsSpending);
router.get('/restaurants', restaurantRevenue);

// The platform's money rules (fees, rates, switches) — versioned; POST always adds a version.
router.get('/settings', getSettings);
router.post('/settings', createSettingsVersion);

// One order's / bill's full money picture: charges, settlement line (Razorpay fee and Yulo's
// margin included), and its ledger rows.
router.get('/orders/:orderId/breakdown', orderBreakdown);
router.get('/bills/:billId/breakdown', billBreakdown);

// Refunds: list (filter ?status=pending|processing|processed|failed) and retry a failed one.
router.get('/refunds', listRefunds);
router.post('/refunds/:orderId/retry', retryRefund);

// Weekly restaurant settlements. Literal paths before '/:id'.
// Orders & Money and the Weekly Report (services/moneyReport.service.js).
router.get('/money', moneyReport.money);
router.get('/weekly-report', moneyReport.weekly);
router.post('/weekly-report/restaurants/:settlementId/mark-paid', onlyIfReleased, moneyReport.payRestaurant);
router.post('/weekly-report/riders/:payoutId/mark-paid', moneyReport.payRider);

router.get('/settlements', settlements.list);
router.post('/settlements/generate', weeklyRetired, settlements.generate);
router.post('/settlements/adjustments', settlements.adjust);
router.get('/settlements/export', settlements.exportWeek);
router.get('/settlements/:id', settlements.detail);
router.get('/settlements/:id/export', settlements.exportOne);
router.patch('/settlements/:id/approve', weeklyRetired, settlements.approve);
router.patch('/settlements/:id/hold', settlements.hold);
router.patch('/settlements/:id/unhold', settlements.unhold);
router.patch('/settlements/:id/mark-paid', onlyIfReleased, settlements.markPaid);
router.patch('/settlements/:id/retry-payout', weeklyRetired, payoutBatches.retrySettlement);
router.patch('/settlements/:id/carry-forward', weeklyRetired, payoutBatches.carryForward);

// Restaurant Payouts (B12): the screens' reads and the manual lifecycle — schedule → release →
// mark paid / mark failed → reschedule; hold / update reason / release hold. Literal paths first.
router.get('/payouts/live', moneyReport.live);
router.get('/payouts/weekly', payouts.weekly);
router.get('/payouts/clearance', payouts.clearance);
router.get('/payouts/history', payouts.history);
router.get('/payouts/history/export', payouts.historyExport);
router.get('/payouts/options', payouts.options);
router.get('/payouts/:id', payouts.detail);
router.get('/payouts/:id/pdf', payouts.statementPdf);
router.get('/payouts/:id/receipt.pdf', payouts.receiptPdf);
router.patch('/payouts/:id/schedule', weeklyRetired, payouts.schedule);
router.patch('/payouts/:id/schedule-date', weeklyRetired, payouts.changeDate);
router.patch('/payouts/:id/reschedule', weeklyRetired, payouts.reschedule);
router.patch('/payouts/:id/release', weeklyRetired, payouts.release);
router.patch('/payouts/:id/mark-paid', payouts.markPaid);
router.patch('/payouts/:id/mark-failed', payouts.markFailed);
router.patch('/payouts/:id/hold', payouts.hold);
router.patch('/payouts/:id/hold-reason', payouts.holdReason);
router.patch('/payouts/:id/release-hold', payouts.releaseHold);

// Paying restaurants any day, in full or in part, and the daily / range report.
router.get('/restaurant-payouts/balances', restaurantPayouts.balances);
router.get('/restaurant-payouts/balances/:restaurantId', restaurantPayouts.balance);
router.post('/restaurant-payouts/balances/:restaurantId/pay', restaurantPayouts.pay);
router.get('/restaurant-payouts/payments', restaurantPayouts.payments);
router.get('/restaurant-payouts/daily', restaurantPayouts.daily);
router.get('/restaurant-payouts/daily/export.xlsx', restaurantPayouts.dailyExport);

// Optional: releasing scheduled payouts as one bank bulk-upload file (B9).
router.get('/payout-batches', payoutBatches.list);
router.post('/payout-batches', weeklyRetired, payoutBatches.create);
router.get('/payout-batches/:id', payoutBatches.detail);
router.get('/payout-batches/:id/file', payoutBatches.file);
router.post('/payout-batches/:id/reconcile', payoutBatches.reconcile);
router.post('/payout-batches/:id/cancel', payoutBatches.cancel);

export default router;
