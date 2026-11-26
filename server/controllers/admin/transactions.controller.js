import * as transactions from '../../services/transactions.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// The super admin's Transactions ledger (services/transactions.service.js): every payment in and
// out — orders, dine-in bills, seller plans, SMS credits, job fees, refunds and payouts.

const filters = (q) => ({
  from: q.from || undefined,
  to: q.to || undefined,
  direction: q.direction || undefined,
  kind: q.kind || undefined,
  q: q.q || undefined,
});

/** GET /api/admin/transactions?from&to&direction&kind&q&page&limit */
export const list = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Transactions', await transactions.listTransactions({ ...filters(req.query), page: req.query.page, limit: req.query.limit }));
});

/** GET /api/admin/transactions/summary — the dashboard card. */
export const summary = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Transactions summary', await transactions.dashboardSummary());
});

/** GET /api/admin/transactions/export.xlsx — the same filters, every matching row. */
export const exportXlsx = asyncHandler(async (req, res) => {
  const { buffer, filename } = await transactions.exportTransactions(filters(req.query));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});
