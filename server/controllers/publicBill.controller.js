import { z } from 'zod';
import TableSession from '../models/TableSession.js';
import Bill from '../models/Bill.js';
import * as billingService from '../services/billing.service.js';
import * as paymentService from '../services/payment.service.js';
import * as billViewService from '../services/billView.service.js';
import { customerRefundView } from '../services/refund.service.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { toPaise } from '../utils/money.js';
import { publicBillView } from '../utils/publicMask.js';

// Public, table-scoped "pay the bill online" flow (yulo_menu) — a guest-initiated
// counterpart to the staff-side GET/POST .../bill endpoints in controllers/staff/
// waiter.controller.js, reusing the exact same billing.service.js primitives
// (assembleBill/markPaid) rather than a second copy of the settlement logic.
//
// Keyed only by the table QR, so every bill payload here goes through publicBillView: other
// diners' names and phone numbers are masked and internal ids dropped (utils/publicMask.js).

const verifySchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

const publicView = async (bill) => publicBillView(await billViewService.buildBillView(bill));

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
  // The guest paying gets the same bill the waiter and the owner see — their table number,
  // the restaurant's own tax/licence details, every round they ordered, and the same
  // charge breakdown (services/billView.service.js) — minus other people's details.
  sendSuccess(res, 200, 'Bill', { bill: await publicView(bill) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/pay   (also …/bill/pay/retry)
//
// Starts — or resumes — paying the table's bill online. Calling it again (the guest closed
// Razorpay, the app reloaded) hands back the SAME Razorpay order while Razorpay still accepts
// payments on it for this amount, and only creates a new one when the bill changed or the old
// one can no longer be paid. 409 PAYMENT_ALREADY_RECEIVED when a payment already went through
// and is settling — poll GET …/bill/payment.
export const payBill = asyncHandler(async (req, res) => {
  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  if (!session.orders.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to pay yet');
  }

  // Same rule the floor's "Generate bill" enforces (billing.service.assertSessionFullyServed):
  // the total isn't final while the kitchen still holds a round, so the guest must not be
  // charged against it. Checked HERE, before any money moves — never in verify/webhook,
  // where a throw would leave a paid guest with an unsettled bill.
  await billingService.assertSessionFullyServed(session._id);

  const bill = await billingService.assembleBill(session._id);
  if (bill.grandTotal <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to pay');
  }

  // Throws (503 no gateway / 502 gateway error / 409 already paid) BEFORE the session is
  // locked below, so a failed attempt never leaves the table stuck in 'bill_requested' with
  // nothing to pay with. null only in dev simulation mode — the client then uses
  // .../bill/pay/simulate.
  const result = await paymentService.ensureRazorpayOrder(bill, {
    amountPaise: toPaise(bill.grandTotal),
    receipt: bill._id,
    notes: { billId: String(bill._id) },
  });

  if (result && !result.reused) {
    // Only onto a bill still open — it may have been settled at the counter meanwhile.
    const { id, amount } = result.razorpayOrder;
    const adopted = await Bill.updateOne(
      { _id: bill._id, status: 'open' },
      { $set: { paymentIntentId: id, paymentAmountPaise: amount }, $addToSet: { paymentIntentHistory: id } }
    );
    if (!adopted.matchedCount) throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has already been settled');
    paymentService.adoptRazorpayOrder(bill, result.razorpayOrder);
  }

  // Locks the session against new orders while payment is in flight —
  // guestOrder.service.js's getOrOpenSession only reuses a session with status 'open',
  // so anything a guest places mid-payment opens a fresh session/tab instead of silently
  // landing in the batch this payment is about to settle (markPaid's order update isn't
  // scoped to just this bill's own batches).
  await TableSession.updateOne({ _id: session._id, status: 'open' }, { $set: { status: 'bill_requested' } });
  // Starts (or restarts) the hold on the bill's total — released if the guest abandons it
  // (billing.service.js PAYMENT_HOLD_MS) or by staff (…/release-payment).
  await Bill.updateOne({ _id: bill._id, status: 'open' }, { $set: { paymentStartedAt: new Date() } });

  sendSuccess(res, 200, 'Bill payment initiated', {
    bill: await publicView(bill),
    razorpayOrder: result?.razorpayOrder ?? null,
    reused: result?.reused ?? false,
    paymentSimulated: !result,
  });
});

// POST /api/restaurants/:id/tables/:tableId/bill/pay/simulate — dev/local stand-in for a
// real payment, mirrors order.controller.js's simulatePayment. Only exists when payment
// simulation is on (config/payments.config.js); never in production. This route is public
// (keyed only by the table QR), which is exactly why it must not exist where money is real.
export const simulateBillPayment = asyncHandler(async (req, res) => {
  if (!paymentSimulationEnabled) {
    throw new ApiError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`);
  }

  const session = await findPayableSession(req.publicRestaurant._id, req.params.tableId);
  const bill = await Bill.findOne({ tableSessionId: session._id, status: 'open' });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');

  const updated = await billingService.markPaid({
    billId: bill._id,
    restaurantId: req.publicRestaurant._id,
    paymentMethod: 'online',
    payment: { via: 'simulation' },
  });

  sendSuccess(res, 200, 'Payment simulated', { bill: await publicView(updated) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/verify
export const verifyBillPaymentHandler = asyncHandler(async (req, res) => {
  const result = verifySchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment verification data', result.error.flatten());
  }

  // Found by the Razorpay order the guest paid against, not by the open session: if the
  // webhook got there first, the session is already closed — that's a success, not a 404.
  const bill = await Bill.findOne({
    restaurantId: req.publicRestaurant._id,
    tableId: req.params.tableId,
    $or: [{ paymentIntentId: result.data.razorpay_order_id }, { paymentIntentHistory: result.data.razorpay_order_id }],
  });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found for this payment');

  let settled;
  try {
    // Checks the payment against the bill's current total and settles it atomically. A bill
    // already settled by this payment (the webhook got there first) is a success.
    settled = await paymentService.verifyBillPayment(bill, result.data);
  } catch (err) {
    // Only a payment Razorpay itself confirmed can't settle this bill (wrong amount, or the
    // bill changed under it) reopens the table for ordering/retrying. Never on:
    //   - a bad signature or a payment that isn't this bill's — anyone with the table QR can
    //     send one, and reopening would let new rounds join a bill a guest is paying for;
    //   - a gateway error — the payment may well have gone through (the webhook settles it);
    //   - a bill already settled.
    // An abandoned payment is released by …/cancel, by staff, or after the hold expires.
    if (err?.gatewayChecked || err?.code === 'BILL_TOTAL_CHANGED') {
      await TableSession.updateOne({ _id: bill.tableSessionId, status: 'bill_requested' }, { $set: { status: 'open' } });
    }
    throw err;
  }

  sendSuccess(res, 200, 'Payment verified', { bill: await publicView(settled) });
});

// POST /api/restaurants/:id/tables/:tableId/bill/cancel — the guest backed out of the
// Razorpay checkout without completing it. Reopens the session rather than leaving it
// stuck in 'bill_requested' — but NEVER while a payment against this bill is authorized or
// captured: the guest may have paid and only lost the confirmation (409; the app polls
// GET …/bill/payment and the webhook settles the bill). A no-op if nothing is in flight.
export const cancelBillPayment = asyncHandler(async (req, res) => {
  const session = await TableSession.findOne({
    restaurantId: req.publicRestaurant._id,
    tableId: req.params.tableId,
    status: 'bill_requested',
  }).lean();
  if (!session) return sendSuccess(res, 200, 'Bill payment cancelled', null);

  const bill = await Bill.findOne({ tableSessionId: session._id, status: 'open' }).lean();
  const intents = [...new Set([...(bill?.paymentIntentHistory ?? []), bill?.paymentIntentId].filter(Boolean))];
  // Gateway errors propagate (502) — "couldn't check" must not reopen a table that may be paid.
  if (bill && (await paymentService.hasLivePayment(intents, { expectedPaise: toPaise(bill.grandTotal) }))) {
    throw new ApiError(
      409,
      'PAYMENT_IN_PROGRESS',
      'A payment for this bill is already going through — it will show as paid in a moment'
    );
  }

  await TableSession.updateOne({ _id: session._id, status: 'bill_requested' }, { $set: { status: 'open' } });
  sendSuccess(res, 200, 'Bill payment cancelled', null);
});

// How long after a sitting closes its payment status is still shown to a poll that doesn't name
// the payment — long enough for a guest whose verify call was lost, short enough that the next
// party at the table doesn't see it.
const RECENTLY_CLOSED_MS = 15 * 60 * 1000;

// GET /api/restaurants/:id/tables/:tableId/bill/payment[?razorpayOrderId=…] — where the
// table's bill payment stands, for a guest app whose verify call failed or never returned.
// Status only; no bill contents, no personal details.
//
// With razorpayOrderId (what the guest's app was paying), that bill. Without it, the bill of
// the table's current sitting, or one closed in the last few minutes — never an older party's.
export const getBillPaymentStatus = asyncHandler(async (req, res) => {
  const scope = { restaurantId: req.publicRestaurant._id, tableId: req.params.tableId };
  const razorpayOrderId = typeof req.query.razorpayOrderId === 'string' ? req.query.razorpayOrderId : null;

  let bill;
  let session = null;
  if (razorpayOrderId) {
    bill = await Bill.findOne({
      ...scope,
      $or: [{ paymentIntentId: razorpayOrderId }, { paymentIntentHistory: razorpayOrderId }],
    }).lean();
  } else {
    bill = await Bill.findOne(scope).sort({ createdAt: -1 }).lean();
    session = bill?.tableSessionId ? await TableSession.findById(bill.tableSessionId).select('status closedAt').lean() : null;
    const live = ['open', 'bill_requested'].includes(session?.status);
    const closedAt = bill?.closedAt ?? session?.closedAt ?? null;
    const recent = closedAt && Date.now() - new Date(closedAt).getTime() < RECENTLY_CLOSED_MS;
    if (bill && !live && !recent) bill = null;
  }
  if (!bill) return sendSuccess(res, 200, 'Payment status', { bill: null });

  if (!session && bill.tableSessionId) {
    session = await TableSession.findById(bill.tableSessionId).select('status').lean();
  }
  sendSuccess(res, 200, 'Payment status', {
    bill: {
      billId: bill._id,
      billNumber: bill.billNumber,
      status: bill.status,
      paid: bill.status === 'paid',
      paymentChannel: bill.paymentChannel ?? null,
      confirmedVia: bill.paymentConfirmedVia ?? null,
      failureReason: bill.paymentFailureReason ?? null,
      amount: bill.grandTotal,
      sessionStatus: session?.status ?? null,
      refund: customerRefundView(bill),
    },
  });
});
