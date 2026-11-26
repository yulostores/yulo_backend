import { Router } from 'express';
import * as payments from '../../controllers/owner/payments.controller.js';
import * as pdfs from '../../controllers/owner/pdf.controller.js';

// /api/owner/:restaurantId/payments — the Payments & Payouts screens (B12 task 6). Read-only;
// the restaurant's money is never cached by a browser or proxy.
const router = Router({ mergeParams: true });
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/overview', payments.overview);
// Paid any day: balance, payments received, and the daily / range report.
router.get('/balance', payments.balance);
router.get('/received', payments.received);
router.get('/daily', payments.daily);
router.get('/daily/export.xlsx', payments.dailyExport);
router.get('/history', payments.history);
router.get('/statements/:statementId', payments.statement);
router.get('/orders/:orderId', payments.order);
router.get('/orders/:orderId/pdf', pdfs.orderPdf);
router.get('/bills/:billId', payments.bill);
router.get('/bills/:billId/pdf', pdfs.billPdf);
router.get('/settings', payments.settings);

export default router;
