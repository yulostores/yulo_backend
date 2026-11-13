import * as bills from '../../services/sellerBills.service.js';
import { logActivity } from '../../services/activityLog.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendPdf } from '../../utils/sendPdf.js';

// Super admin — the bills Yulo issues to coupon sellers (plans and SMS credits).

/** GET /api/admin/seller-bills?q&seller&kind&method&from&to&page&limit — page + report summary. */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Seller bills', await bills.listSellerBills(req.query));
});

/** GET /api/admin/seller-bills/export.csv — the filtered bills (all pages) with a totals row. */
export const exportCsv = asyncHandler(async (req, res) => {
  const csv = await bills.sellerBillsCsv(req.query);
  await logActivity({ adminId: req.user._id, action: 'SELLER_BILLS_EXPORTED', targetType: 'seller', metadata: { filters: req.query } });
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="seller-bills-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

/** GET /api/admin/seller-bills/:id — one bill in full. */
export const detail = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Seller bill', await bills.sellerBillDetail(req.params.id));
});

/** GET /api/admin/seller-bills/:id/pdf — the bill as a PDF download. */
export const pdf = asyncHandler(async (req, res) => {
  sendPdf(res, await bills.sellerBillPdf(req.params.id));
});
