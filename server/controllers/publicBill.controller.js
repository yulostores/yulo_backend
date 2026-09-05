import { z } from 'zod';
import TableSession from '../models/TableSession.js';
import Bill from '../models/Bill.js';
import * as billingService from '../services/billing.service.js';
import * as paymentService from '../services/payment.service.js';
import * as billViewService from '../services/billView.service.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

// Public, table-scoped "pay the bill online" flow (yulo_menu) — a guest-initiated
// counterpart to the staff-side GET/POST .../bill endpoints in controllers/staff/
// waiter.controller.js, reusing the exact same billing.service.js primitives
// (assembleBill/markPaid) rather than a second copy of the settlement logic.

const verifySchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

// A bill can be viewed/paid while the session is still 'open' (still ordering) or
// 'bill_requested' (a payment already in flight, started by payBill below) — never once
// it's 'paid'/'cancelled'.
const findPayableSession = async (restaurantId, tableId) => {
  const session = await TableSession.findOne({
    restaurantId,
    tableId,
    status: { $in: ['open', 'bill_requested'] },
  }).lean();
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'No open table session for this table');
  return session;
};

// GET /api/restaurants/:id/tables/:tableId/bill
export const getBill = asyncHandler(async (req, res) => {
  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  if (!session.orders.length) {
    return sendSuccess(res, 200, 'Bill', { bill: null });
  }

  const bill = await billingService.assembleBill(session._id);
  // The guest paying gets exactly what the waiter and the owner see — their table number,
  // the restaurant's own tax/licence details, every round they ordered, and the same
  // charge breakdown. See services/billView.service.js.
  sendSuccess(res, 200, 'Bill', { bill: await billViewService.buildBillView(bill) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/pay
export const payBill = asyncHandler(async (req, res) => {
  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  if (!session.orders.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to pay yet');
  }

  const bill = await billingService.assembleBill(session._id);
  if (bill.grandTotal <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to pay');
  }

  let razorpayOrder = null;
  try {
    razorpayOrder = await paymentService.createRazorpayOrder({
      amountRupees: bill.grandTotal,
      receipt: bill._id,
    });
  } catch (err) {
    logger.error({ err, billId: bill._id }, 'Razorpay order creation failed for bill');
  }

  if (razorpayOrder) {
    bill.paymentIntentId = razorpayOrder.id;
    await bill.save();
  }

  // Locks the session against new orders while payment is in flight —
  // guestOrder.service.js's getOrOpenSession only reuses a session with status 'open',
  // so anything a guest places mid-payment opens a fresh session/tab instead of silently
  // landing in the batch this payment is about to settle (markPaid's order update isn't
  // scoped to just this bill's own batches).
  await TableSession.updateOne({ _id: session._id, status: 'open' }, { $set: { status: 'bill_requested' } });

  sendSuccess(res, 200, 'Bill payment initiated', {
    bill: await billViewService.buildBillView(bill),
    razorpayOrder,
  });
});

// POST /api/restaurants/:id/tables/:tableId/bill/pay/simulate — dev/local fallback for
// when the server has no Razorpay key configured, mirrors order.controller.js's
// simulatePayment. Settles the bill the same way a real payment's verify call would.
export const simulateBillPayment = asyncHandler(async (req, res) => {
  if (env.RAZORPAY_KEY_ID) {
    throw new ApiError(400, 'NOT_SIMULATED', 'A real payment gateway is configured; simulation is unavailable');
  }

  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  const bill = await Bill.findOne({ tableSessionId: session._id, status: 'open' });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');

  const updated = await billingService.markPaid({
    billId: bill._id,
    restaurantId: req.publicRestaurant._id,
    paymentMethod: 'online',
  });

  sendSuccess(res, 200, 'Payment simulated', { bill: await billViewService.buildBillView(updated) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/verify
export const verifyBillPaymentHandler = asyncHandler(async (req, res) => {
  const result = verifySchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment verification data', result.error.flatten());
  }

  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  const bill = await Bill.findOne({ tableSessionId: session._id, status: 'open' });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found or already settled');

  try {
    await paymentService.verifyBillPayment(bill, result.data);
  } catch (err) {
    // Signature didn't check out — reopen the session for ordering/retrying rather than
    // leaving it stuck in 'bill_requested'.
    await TableSession.updateOne({ _id: session._id, status: 'bill_requested' }, { $set: { status: 'open' } });
    throw err;
  }

  const updated = await billingService.markPaid({
    billId: bill._id,
    restaurantId: req.publicRestaurant._id,
    paymentMethod: 'online',
  });

  sendSuccess(res, 200, 'Payment verified', { bill: await billViewService.buildBillView(updated) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/cancel — the guest backed out of the
// Razorpay checkout without completing it. Reopens the session rather than leaving it
// stuck in 'bill_requested'; a no-op if it already settled (webhook/verify beat this call).
export const cancelBillPayment = asyncHandler(async (req, res) => {
  await TableSession.updateOne(
    { restaurantId: req.publicRestaurant._id, tableId: req.params.tableId, status: 'bill_requested' },
    { $set: { status: 'open' } }
  );
  sendSuccess(res, 200, 'Bill payment cancelled', null);
});
