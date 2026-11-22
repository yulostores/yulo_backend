// The owner's edits to a dine-in bill after the table is served and before it is paid:
//   • generate it (the same assembleBill the floor's "Generate bill" runs);
//   • lower a dish's quantity or remove it — the round (Order) itself is changed, so the bill,
//     the order history and the owner's reports all agree; a round left empty is cancelled;
//   • set (or clear) a discount — flat ₹ or a % of the subtotal.
// Every change is written to Bill.adjustments and the bill is re-totalled by assembleBill.
// Nothing can change while the guest is paying online (the amount they were asked for is the
// bill), and a paid bill is a record, never edited.

import Bill from '../models/Bill.js';
import Order from '../models/Order.js';
import TableSession from '../models/TableSession.js';
import { ApiError } from '../utils/ApiError.js';
import { assembleBill, assertSessionFullyServed } from './billing.service.js';

const round2 = (n) => Math.round(n * 100) / 100;

const loadEditableBill = async (restaurantId, billId) => {
  const bill = await Bill.findOne({ _id: billId, restaurantId });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.type !== 'dine_in' || !bill.tableSessionId) {
    throw new ApiError(400, 'NOT_EDITABLE', 'Only a dine-in table bill can be edited');
  }
  if (bill.status !== 'open') throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has already been settled');
  if (bill.paymentIntentId) {
    const session = await TableSession.findById(bill.tableSessionId).select('status').lean();
    if (session?.status === 'bill_requested') {
      throw new ApiError(409, 'PAYMENT_IN_PROGRESS', 'The guest is paying this bill online — it can\'t be changed now');
    }
  }
  return bill;
};

/** Open table sittings for the owner's "Generate bill" list. */
export const openTables = async (restaurantId) => {
  const sessions = await TableSession.find({ restaurantId, status: { $in: ['open', 'bill_requested'] } })
    .populate('orders', 'status subtotal items batchNumber')
    .populate('tableId', 'identifier')
    .sort({ openedAt: 1 })
    .lean();
  const bills = await Bill.find({ tableSessionId: { $in: sessions.map((s) => s._id) } })
    .select('tableSessionId status billNumber grandTotal')
    .lean();
  const billBySession = new Map(bills.map((b) => [String(b.tableSessionId), b]));
  return sessions.map((s) => {
    const live = (s.orders ?? []).filter((o) => o.status !== 'cancelled');
    const bill = billBySession.get(String(s._id)) ?? null;
    return {
      sessionId: s._id,
      table: s.tableId?.identifier ?? null,
      openedAt: s.openedAt ?? null,
      status: s.status,
      rounds: live.length,
      itemCount: live.reduce((n, o) => n + (o.items ?? []).reduce((m, i) => m + i.quantity, 0), 0),
      subtotal: round2(live.reduce((n, o) => n + (o.subtotal ?? 0), 0)),
      // Every round carried to the table — the bill can be generated.
      allServed: live.length > 0 && live.every((o) => ['served', 'delivered'].includes(o.status)),
      bill: bill ? { _id: bill._id, billNumber: bill.billNumber, status: bill.status, grandTotal: bill.grandTotal } : null,
    };
  });
};

/** Generate (or refresh) the bill for a served table. */
export const generateBill = async (restaurantId, sessionId) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId }).select('_id').lean();
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Table sitting not found');
  await assertSessionFullyServed(sessionId);
  return assembleBill(sessionId);
};

/**
 * Lower one dish line's quantity (0 removes it). `lineIndex` is the line's position in the
 * round, as the bill lists it. Raising a quantity is not an edit — that is a new order.
 */
export const setLineQuantity = async ({ restaurantId, billId, orderId, lineIndex, quantity, by }) => {
  const bill = await loadEditableBill(restaurantId, billId);
  const order = await Order.findOne({ _id: orderId, restaurantId, tableSessionId: bill.tableSessionId });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'That round is not on this bill');
  if (order.status === 'cancelled') throw new ApiError(400, 'VALIDATION_ERROR', 'That round was already cancelled');
  const line = order.items[lineIndex];
  if (!line) throw new ApiError(404, 'NOT_FOUND', 'That dish is not on this bill');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity >= line.quantity) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Quantity must be between 0 and ${line.quantity - 1}`);
  }

  const fromQty = line.quantity;
  const itemName = line.name;
  if (quantity === 0) order.items.splice(lineIndex, 1);
  else line.quantity = quantity;

  order.subtotal = round2(order.items.reduce((sum, i) => sum + i.price * i.quantity, 0));
  if (order.grandTotal != null) order.grandTotal = order.subtotal;
  if (order.items.length === 0) {
    // Every dish of the round removed: the round itself is cancelled, kept for the record.
    order.status = 'cancelled';
    order.cancelledAt = new Date();
    order.cancelledBy = 'restaurant';
    order.cancellationReason = 'Removed from the bill by the restaurant';
  }
  await order.save();
  await Bill.updateOne(
    { _id: bill._id },
    { $push: { adjustments: { by, kind: 'quantity', orderId: order._id, itemName, fromQty, toQty: quantity } } }
  );
  return assembleBill(bill.tableSessionId);
};

/** Set the owner's discount on the bill ({ type: 'flat' | 'percent', value }); value 0 removes it. */
export const setManualDiscount = async ({ restaurantId, billId, type, value, by }) => {
  const bill = await loadEditableBill(restaurantId, billId);
  if (!['flat', 'percent'].includes(type)) throw new ApiError(400, 'VALIDATION_ERROR', 'type must be flat or percent');
  if (!Number.isFinite(value) || value < 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a discount of 0 or more');
  if (type === 'percent' && value > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'A percentage discount can be at most 100%');
  if (type === 'flat' && value > bill.subtotal) {
    throw new ApiError(400, 'VALIDATION_ERROR', `The discount can be at most the bill's ₹${bill.subtotal} of food`);
  }

  const others = (bill.discountsApplied ?? []).filter((d) => !d.manual).map((d) => (d.toObject ? d.toObject() : d));
  const label = type === 'percent' ? `${value}%` : `₹${value}`;
  const discountsApplied =
    value > 0
      ? [...others, { description: `Restaurant discount (${label})`, manual: true, manualType: type, manualValue: value, amount: 0 }]
      : others;
  await Bill.updateOne(
    { _id: bill._id, status: 'open' },
    {
      $set: { discountsApplied },
      $push: { adjustments: { by, kind: 'discount', discount: value > 0 ? label : 'removed' } },
    }
  );
  // assembleBill prices the manual discount against the current subtotal and re-totals.
  return assembleBill(bill.tableSessionId);
};

/** Take the restaurant's fixed service charge off this bill, or put it back. */
export const setServiceCharge = async ({ restaurantId, billId, enabled, by }) => {
  const bill = await loadEditableBill(restaurantId, billId);
  if (typeof enabled !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', 'enabled must be true or false');
  await Bill.updateOne(
    { _id: bill._id, status: 'open' },
    {
      $set: { serviceChargeRemoved: !enabled },
      $push: { adjustments: { by, kind: 'service_charge', discount: enabled ? 'added' : 'removed' } },
    }
  );
  return assembleBill(bill.tableSessionId);
};
