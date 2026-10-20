import Bill from '../../models/Bill.js';
import * as billViewService from '../../services/billView.service.js';
import * as billingService from '../../services/billing.service.js';
import * as counterPaymentService from '../../services/counterPayment.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Every response here goes through billView.service.js, which is also what the waiter,
// guest and platform-admin bill endpoints return — one bill shape for all four portals.

export const listBills = asyncHandler(async (req, res) => {
  const { status, type, tableNumber, from, to, q, page = 1, limit = 20 } = req.query;
  const filter = { restaurantId: req.restaurant._id };
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (tableNumber) filter.tableNumber = tableNumber;

  // Bills are looked up by the day they were raised at least as often as by anything
  // else — a shift's takings, yesterday's covers.
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }

  // Free text over the two things anyone actually reads off a bill: its receipt number
  // and the table it belongs to.
  const term = String(q ?? '').trim();
  if (term) {
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ billNumber: rx }, { tableNumber: rx }];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [bills, total] = await Promise.all([
    Bill.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Bill.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Bills', {
    bills: await billViewService.buildBillViews(bills),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

export const getBill = asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({
    _id: req.params.billId,
    restaurantId: req.restaurant._id,
  }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  sendSuccess(res, 200, 'Bill', { bill: await billViewService.buildBillView(bill) });
});

// GET /api/owner/:restaurantId/orders/:orderId/bill — the order -> bill lookup the portal
// had no way to make. A dine-in order resolves to its table session's bill (which batches
// several rounds); a delivery/takeaway order to its own single-order bill. `bill: null`
// with a 200 is the honest answer for a sitting that has not been billed yet, and is what
// the caller renders as "not billed yet" rather than an error.
export const getBillForOrder = asyncHandler(async (req, res) => {
  const { order, bill } = await billViewService.findBillForOrder({
    orderId: req.params.orderId,
    restaurantId: req.restaurant._id,
  });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  sendSuccess(res, 200, 'Bill', { bill });
});

// POST /api/owner/:restaurantId/bills/:billId/mark-paid — body { method: 'cash'|'upi'|'card' }.
// The owner settling a dine-in bill paid at the table, the same as the waiter's mark-paid:
// recorded as a counter payment (the restaurant owes Yulo the platform fee for it), refused
// with 409 when the guest has paid — or is paying — online, or the bill is already settled.
export const markBillPaid = asyncHandler(async (req, res) => {
  const bill = await Bill.findOne({ _id: req.params.billId, restaurantId: req.restaurant._id }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  // A table can't be closed out while the kitchen still owes it a round — same rule as the floor.
  if (bill.status === 'open' && bill.tableSessionId) {
    await billingService.assertSessionFullyServed(bill.tableSessionId);
  }

  const paid = await counterPaymentService.markPaidAtCounter({
    billId: bill._id,
    restaurantId: req.restaurant._id,
    method: req.body?.method,
  });
  sendSuccess(res, 200, 'Bill marked as paid', { bill: await billViewService.buildBillView(paid) });
});

// POST /api/owner/:restaurantId/bills/:billId/release-payment — releases a dine-in bill held
// for a guest's online payment (they walked away from Razorpay, or will pay at the counter):
// the sitting reopens and the bill is re-priced. 409 PAYMENT_IN_PROGRESS while a payment that
// can still settle it is going through.
export const releaseBillPayment = asyncHandler(async (req, res) => {
  const bill = await billingService.releasePayment({ billId: req.params.billId, restaurantId: req.restaurant._id });
  sendSuccess(res, 200, 'Bill payment released', { bill: await billViewService.buildBillView(bill) });
});
