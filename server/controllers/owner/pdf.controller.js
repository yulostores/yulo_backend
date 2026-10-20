import { asyncHandler } from '../../utils/asyncHandler.js';
import * as pdfs from '../../services/pdf/statements.js';
import { sendPdf } from '../../utils/sendPdf.js';

// The restaurant's PDF downloads — the statement and order/bill pages as documents. Same
// owner-only scoping as the JSON endpoints (another restaurant's id answers 404).

// GET /api/owner/:restaurantId/settlements/:settlementId/pdf
export const statementPdf = asyncHandler(async (req, res) => {
  sendPdf(res, await pdfs.ownerStatementPdf(req.restaurant._id, req.params.settlementId));
});

// GET /api/owner/:restaurantId/payments/orders/:orderId/pdf
export const orderPdf = asyncHandler(async (req, res) => {
  sendPdf(res, await pdfs.ownerPaymentPdf(req.restaurant._id, 'order', req.params.orderId));
});

// GET /api/owner/:restaurantId/payments/bills/:billId/pdf
export const billPdf = asyncHandler(async (req, res) => {
  sendPdf(res, await pdfs.ownerPaymentPdf(req.restaurant._id, 'bill', req.params.billId));
});
