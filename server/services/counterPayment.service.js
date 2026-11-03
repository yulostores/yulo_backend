import Bill from '../models/Bill.js';
import { ApiError } from '../utils/ApiError.js';
import * as billingService from './billing.service.js';
import { hasLivePayment } from './payment.service.js';
import { toPaise } from '../utils/money.js';

// Staff (waiter) or owner settling a dine-in bill paid at the table — cash, UPI to the
// restaurant's own handle, or the restaurant's card machine. That money never reaches Yulo,
// so markPaid records the bill as paymentChannel 'counter' and the restaurant's ledger takes
// the platform-fee debit (services/ledger.service.js).
//
// Refused when the guest has paid — or is paying — online for the same bill: the table would
// be paid twice. A guest who opened Razorpay and then handed over cash instead still works:
// only an authorized/captured payment blocks, not an abandoned checkout.

export const COUNTER_METHODS = ['cash', 'upi', 'card'];

export const markPaidAtCounter = async ({ billId, restaurantId, method, expectedTotal }) => {
  if (!COUNTER_METHODS.includes(method)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `method must be one of ${COUNTER_METHODS.join(', ')}`);
  }

  let bill = await Bill.findOne({ _id: billId, restaurantId }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.type !== 'dine_in') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only dine-in bills are settled at the counter');
  }

  // The stored bill is only as fresh as its last assemble. A round rung in after the bill was
  // raised (the waiter's "Add items" on the same sitting) wasn't on it, and settling it as
  // stored closed the sitting at the old total while marking every round — the new one too —
  // paid. Re-price first; if the person settling was looking at a different total, stop and
  // let them see the new one rather than record an amount nobody confirmed.
  if (bill.status === 'open' && bill.tableSessionId) {
    const fresh = await billingService.assembleBill(bill.tableSessionId);
    bill = fresh?.toObject ? fresh.toObject() : fresh;
    if (bill?.status === 'open' && expectedTotal != null && toPaise(Number(expectedTotal)) !== toPaise(bill.grandTotal)) {
      throw new ApiError(409, 'BILL_TOTAL_CHANGED', `The bill is now ₹${bill.grandTotal.toFixed(2)} — a round was added. Check it and mark it paid again.`, {
        grandTotal: bill.grandTotal,
      });
    }
  }

  if (bill.status === 'open') {
    const intents = [...new Set([...(bill.paymentIntentHistory ?? []), bill.paymentIntentId].filter(Boolean))];
    // Only a payment that can still settle this bill blocks: one already refused and owed back
    // (or for a different amount) never will.
    if (await hasLivePayment(intents, { expectedPaise: toPaise(bill.grandTotal) })) {
      throw new ApiError(
        409,
        'PAID_ONLINE',
        'The guest has already paid this bill online — it will show as paid in a moment'
      );
    }
  }

  // markPaid answers 409 BILL_ALREADY_PAID for a bill that is no longer open.
  return billingService.markPaid({ billId: bill._id, restaurantId, paymentMethod: method });
};
