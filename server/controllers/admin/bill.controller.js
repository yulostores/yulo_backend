import mongoose from 'mongoose';
import Bill from '../../models/Bill.js';
import * as billViewService from '../../services/billView.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Platform-wide bill oversight. The admin console could report revenue in aggregate (see
// services/finance.service.js, which sums the same collection) but could not open the
// individual receipt behind a figure — so a disputed charge, a table number, or what a
// guest was actually billed for was invisible to the platform.
//
// Responses go through billView.service.js, the same shaping the owner, waiter and guest
// endpoints use, so a bill reads identically in all four portals.

const buildFilter = (query) => {
  const { restaurantId, status, type, tableNumber, from, to, q } = query;
  const filter = {};

  if (restaurantId) {
    if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid restaurantId');
    }
    filter.restaurantId = new mongoose.Types.ObjectId(restaurantId);
  }
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (tableNumber) filter.tableNumber = tableNumber;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  const term = String(q ?? '').trim();
  if (term) {
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // The receipt number, the table, and the restaurant name as it was printed on the
    // bill — the three things an admin has in hand when a bill is escalated to them.
    filter.$or = [
      { billNumber: rx },
      { tableNumber: rx },
      { 'restaurantSnapshot.name': rx },
    ];
  }

  return filter;
};

// GET /api/admin/bills
export const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const filter = buildFilter(req.query);

  const skip = (Number(page) - 1) * Number(limit);
  const [bills, total] = await Promise.all([
    Bill.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Bill.countDocuments(filter),
  ]);

  // Every row carries `restaurant` — from the bill's own snapshot, or resolved live by
  // billView.service.js for bills raised before snapshots existed — which is what a
  // cross-restaurant listing needs to name the store on each row.
  sendSuccess(res, 200, 'Bills', {
    bills: await billViewService.buildBillViews(bills),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

// GET /api/admin/bills/:billId
export const getOne = asyncHandler(async (req, res) => {
  const bill = await Bill.findById(req.params.billId).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  sendSuccess(res, 200, 'Bill', { bill: await billViewService.buildBillView(bill) });
});
