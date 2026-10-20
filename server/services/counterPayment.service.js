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

export const markPaidAtCounter = async ({ billId, restaurantId, method }) => {
  if (!COUNTER_METHODS.includes(method)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `method must be one of ${COUNTER_METHODS.join(', ')}`);
  }

  const bill = await Bill.findOne({ _id: billId, restaurantId }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.type !== 'dine_in') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only dine-in bills are settled at the counter');
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
  return billingService.markPaid({ billId, restaurantId, paymentMethod: method });
};
