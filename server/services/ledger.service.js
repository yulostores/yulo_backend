import mongoose from 'mongoose';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import FinanceSettings from '../models/FinanceSettings.js';
import { getActiveSettings } from './financeSettings.service.js';
import { computeRestaurantSettlementLine } from './settlementMath.service.js';
import { toPaise } from '../utils/money.js';
import { clearanceTime } from '../utils/workingDays.js';
import logger from '../utils/logger.js';

// WHEN an order or bill becomes money in a restaurant's account (models/RestaurantLedgerEntry.js),
// and the frozen `financials` snapshot that goes with it. services/settlementMath.service.js
// decides WHAT the amount is.
//
//   delivery/takeaway order, paid online, delivered       → order_earning (credit)
//   …or cancelled by the customer after the kitchen started → order_earning, at cancellation
//   dine-in bill paid online                                → dine_in_earning (credit)
//   dine-in bill paid at the counter                        → counter_platform_fee (debit)
//   takeaway order paid at the counter, handed over         → counter_platform_fee (debit)
//
// Each line is worked out with the Finance Settings version that PRICED the order/bill
// (charges.settingsVersionId), so a rate change between placement and delivery doesn't apply
// the new settlement charge to an order the customer paid under the old rules.
//
// The hooks never touch the caller's document: `financials` is platform-internal
// (select:false) and the caller's document is often sent straight back to a rider, a chef or
// a socket room. It is written to the database only.
//
// Online money is only eligible once it has CLEARED (B12): the row's eligibleAt (= clearsAt) is the
// later of the event and Razorpay's T+2 working-day settlement of the payment to Yulo, so it joins
// the statement of the week it clears in. Counter rows, refund fees and adjustments don't wait.
//
// Every write is idempotent: the ledger's unique (type, orderId|billId) indexes turn a repeat
// into a no-op, and `financials` is only set while still null — so the kitchen and the rider
// both closing the same order, or a retried request, never double-credit anyone.
//
// The on* functions are the hooks the order/bill flows call. They never throw: the delivery
// or payment they follow has already happened and must not be reported as failed because the
// ledger write hiccupped. A miss is logged and recoverable with scripts/backfillLedger.js.

const writeEntry = async (fields) => {
  try {
    return await RestaurantLedgerEntry.create(fields);
  } catch (err) {
    if (err?.code === 11000) return null; // already recorded
    throw err;
  }
};

// Razorpay's fee/tax are select:false on Order and Bill (never returned unless asked for), so
// they are read here explicitly rather than trusted from whatever document the caller holds.
const gatewayFeesOf = async (Model, id) => {
  const doc = await Model.findById(id).select('+razorpayFee +razorpayTax').lean();
  return { fee: doc?.razorpayFee ?? 0, tax: doc?.razorpayTax ?? 0 };
};

const entryFromNet = (net) => ({ direction: net >= 0 ? 'credit' : 'debit', amountPaise: Math.abs(net) });

// When online money captured at `capturedAt` may be paid out, given the event that made it the
// restaurant's (`eventAt`): whichever is later. Exported for the clearance queue's projections
// and scripts/backfillClearsAt.js.
export const onlineClearsAt = async (eventAt, capturedAt) => {
  const { settlementCycle } = await getActiveSettings();
  const cleared = clearanceTime(capturedAt ?? eventAt ?? new Date(), { timezone: settlementCycle?.timezone ?? 'Asia/Kolkata' });
  const event = eventAt ? new Date(eventAt) : new Date();
  return cleared.getTime() > event.getTime() ? cleared : event;
};

// The moment the customer's payment was captured: Order/Bill.paidAt (stamped when it was marked
// paid), else — for a document that was created already paid — when it was created.
const capturedAtOf = (doc) => doc.paidAt ?? doc.createdAt ?? null;

// The rules the order/bill was priced under; `at` is the fallback for a breakdown that never
// recorded a version (rebuilt legacy charges) — the rules in force then, or now if unknown.
const settingsFor = async (charges, at) => {
  const id = charges?.settingsVersionId;
  if (id && mongoose.isValidObjectId(id)) {
    const version = await FinanceSettings.findById(id).lean();
    if (version) return version;
  }
  return getActiveSettings(at);
};

// Orders from before paymentChannel existed only say paymentMethod.
const channelOf = (doc) => doc.paymentChannel ?? (doc.paymentMethod === 'online' || doc.paidBy === 'online' ? 'online' : null);

// Rider base + distance pay, frozen on the order at assignment (rupees there) — the tip is the
// rider's too but is tracked separately.
const riderPayPaiseOf = (order) => {
  const e = order.deliveryAssignment?.earningsBreakdown;
  if (!e) return 0;
  return toPaise((e.basePay ?? 0) + (e.distancePay ?? 0));
};

// eligibleAt + clearsAt for an online row: the caller's explicit clearsAt (a backfill that knows
// better), else the later of the event and the payment's T+2 clearance.
const clearing = async (eventAt, capturedAt, explicit) => {
  const at = explicit ? new Date(explicit) : await onlineClearsAt(eventAt ?? new Date(), capturedAt);
  return { eligibleAt: at, clearsAt: at };
};
// …and for a row that doesn't wait (counter money, fees, adjustments).
const immediate = (at) => {
  const when = at ? new Date(at) : new Date();
  return { eligibleAt: when, clearsAt: when };
};

/**
 * Credits a delivery/takeaway order paid online. `charges` overrides the order's own frozen
 * breakdown (the backfill passes a reconstructed one for pre-B3 orders).
 * Returns the ledger row, or null when nothing was (or needed to be) written.
 */
export const recordOrderEarning = async (
  order,
  { eligibleAt, note = '', createdBy = null, charges, settingsAt, clearsAt } = {}
) => {
  if (order.type === 'dine_in') return null;
  if (channelOf(order) !== 'online' || order.paymentStatus !== 'paid') return null;

  const breakdownCharges = charges ?? order.charges;
  if (!breakdownCharges) {
    logger.warn({ orderId: order._id }, 'Order has no price breakdown — not credited (run backfillLedger)');
    return null;
  }

  const fees = await gatewayFeesOf(Order, order._id);
  const line = computeRestaurantSettlementLine({
    charges: breakdownCharges,
    paymentChannel: 'online',
    razorpayFeePaise: fees.fee,
    razorpayTaxPaise: fees.tax,
    riderPayPaise: riderPayPaiseOf(order),
    settings: await settingsFor(breakdownCharges, settingsAt),
  });

  const entry = await writeEntry({
    restaurantId: order.restaurantId,
    type: 'order_earning',
    ...entryFromNet(line.restaurantNet),
    orderId: order._id,
    breakdown: line,
    ...(await clearing(eligibleAt, capturedAtOf(order), clearsAt)),
    createdBy,
    note,
  });
  if (entry) await Order.updateOne({ _id: order._id, financials: null }, { $set: { financials: line } });
  return entry;
};

/**
 * A takeaway order paid at the counter and handed over: the customer paid the restaurant
 * directly, platform fee included, so the restaurant owes Yulo that fee plus the settlement
 * charge on it — the same line as a counter-paid dine-in bill.
 *
 * COD delivery orders are NOT booked here: the rider collects that cash on Yulo's behalf, so
 * the restaurant is owed its share rather than owing a fee — a rule not settled yet (COD is
 * off). Logged so a delivered COD order can't go unnoticed if COD is switched on first.
 */
export const recordCounterOrderFee = async (order, { eligibleAt, note = '', createdBy = null } = {}) => {
  if (order.type === 'dine_in') return null;
  const channel = channelOf(order);
  if (channel === 'cod') {
    logger.error({ orderId: order._id }, 'COD order delivered — no ledger rule for COD yet; settle it by an adjustment');
    return null;
  }
  if (channel !== 'counter' || order.paymentStatus !== 'paid') return null;
  if (!order.charges) {
    logger.warn({ orderId: order._id }, 'Order has no price breakdown — platform fee not recorded');
    return null;
  }

  const line = computeRestaurantSettlementLine({
    charges: order.charges,
    paymentChannel: 'counter',
    settings: await settingsFor(order.charges),
  });
  if (line.restaurantNet === 0) return null;

  const entry = await writeEntry({
    restaurantId: order.restaurantId,
    type: 'counter_platform_fee',
    ...entryFromNet(line.restaurantNet),
    orderId: order._id,
    breakdown: line,
    ...immediate(eligibleAt),
    createdBy,
    note: note || 'Platform fee on a takeaway order paid at the counter',
  });
  if (entry) await Order.updateOne({ _id: order._id, financials: null }, { $set: { financials: line } });
  return entry;
};

/**
 * A paid dine-in bill: online → the restaurant's earning; at the counter → the platform fee
 * (and the settlement charge on it) owed to Yulo.
 */
export const recordBillSettlement = async (bill, { note = '', createdBy = null } = {}) => {
  if (bill.type !== 'dine_in' || bill.status !== 'paid') return null;
  const channel = channelOf(bill) ?? 'counter';
  if (!bill.charges) {
    logger.warn({ billId: bill._id }, 'Bill has no price breakdown — not recorded in the ledger');
    return null;
  }

  const fees = await gatewayFeesOf(Bill, bill._id);
  const line = computeRestaurantSettlementLine({
    charges: bill.charges,
    paymentChannel: channel,
    razorpayFeePaise: fees.fee,
    razorpayTaxPaise: fees.tax,
    settings: await settingsFor(bill.charges),
  });

  await Bill.updateOne({ _id: bill._id, financials: null }, { $set: { financials: line } });
  // A counter-paid bill with no platform fee on it (nothing billed) owes nothing — no row.
  if (line.restaurantNet === 0) return null;

  return writeEntry({
    restaurantId: bill.restaurantId,
    type: channel === 'online' ? 'dine_in_earning' : 'counter_platform_fee',
    ...entryFromNet(line.restaurantNet),
    billId: bill._id,
    breakdown: line,
    ...(channel === 'online' ? await clearing(bill.paidAt, capturedAtOf(bill)) : immediate(bill.paidAt)),
    createdBy,
    note,
  });
};

/**
 * Razorpay keeps its fee when a payment is refunded. When the restaurant bears it (Finance
 * Settings → refundFeeBorneBy for the refund's cause), that fee — `fee` as Razorpay reported
 * it, its GST included — is debited from the restaurant. Written once per order, at the
 * moment the refund is sent. Nothing when the platform bears it or there was no fee.
 */
export const recordRefundGatewayFee = async (order, { cause, feeBorneBy }) => {
  if (feeBorneBy !== 'restaurant') return null;
  const { fee, tax } = await gatewayFeesOf(Order, order._id);
  if (fee <= 0) return null;
  return writeEntry({
    restaurantId: order.restaurantId,
    type: 'refund_gateway_fee',
    direction: 'debit',
    amountPaise: fee,
    orderId: order._id,
    breakdown: {
      cause,
      // Named refundFee, not gateway: unlike on an earning line, this fee IS the restaurant's
      // charge, so the owner view (ownerViewOfLine) must keep it.
      refundFee: { fee: fee - tax, tax, total: fee },
      refundedPaise: order.refund?.amountPaise ?? null,
    },
    ...immediate(),
    note: `Payment gateway fee on a refunded order (${cause.replace(/_/g, ' ')})`,
  });
};

const safely = (label, fn) => async (doc) => {
  try {
    return await fn(doc);
  } catch (err) {
    logger.error({ err, id: doc?._id }, `Ledger write failed (${label}) — recover with scripts/backfillLedger.js`);
    return null;
  }
};

/** Hook: a delivery/takeaway order reached 'delivered' (kitchen or rider side). */
export const onOrderDelivered = safely('order delivered', (order) => {
  const eligibleAt = order.deliveredAt ?? new Date();
  return channelOf(order) === 'online'
    ? recordOrderEarning(order, { eligibleAt })
    : recordCounterOrderFee(order, { eligibleAt });
});

/**
 * Hook: the customer cancelled after the kitchen had started. The customer gets no refund
 * (B5) and the restaurant is paid as if the order had been delivered, eligible from the
 * cancellation. Not reachable until B5 opens that cancel path.
 */
export const onCancelledAfterPreparation = safely('cancelled after preparation', (order) =>
  recordOrderEarning(order, {
    eligibleAt: order.cancelledAt ?? new Date(),
    note: 'Cancelled by the customer after preparation started — no refund',
  })
);

/** Hook: a dine-in bill was settled (online or at the counter). */
export const onBillPaid = safely('bill paid', (bill) => recordBillSettlement(bill));

// ── Reads ─────────────────────────────────────────────────────────────────────

// What a restaurant may see of a settlement line: its own money. Razorpay's fee, Yulo's
// margin on the settlement charge and the rider's pay are platform-internal.
const OWNER_HIDDEN_KEYS = ['gateway', 'yuloSettlementMargin', 'riderPay'];
export const ownerViewOfLine = (line) => {
  if (!line) return null;
  const copy = { ...line };
  for (const key of OWNER_HIDDEN_KEYS) delete copy[key];
  return copy;
};

// Fields of an Order/Bill that never leave the platform side — stripped from any document a
// rider, chef, waiter or owner is sent (they are select:false, but a document can still carry
// them if something loaded or set them).
const INTERNAL_MONEY_FIELDS = ['financials', 'razorpayFee', 'razorpayTax'];
export const withoutInternalMoney = (doc) => {
  if (!doc) return doc;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  for (const key of INTERNAL_MONEY_FIELDS) delete plain[key];
  return plain;
};

// A ledger row as the restaurant sees it — the documented fields only (an allow-list, so a field
// added to the model later, or `createdBy` naming the admin behind an adjustment, never reaches
// the owner by default), with Razorpay's fee, Yulo's margin and rider pay taken out of the line.
export const ownerViewOfEntry = (entry) => ({
  _id: entry._id,
  type: entry.type,
  direction: entry.direction,
  amountPaise: entry.amountPaise,
  orderId: entry.orderId ?? null,
  billId: entry.billId ?? null,
  eligibleAt: entry.eligibleAt,
  clearsAt: entry.clearsAt ?? entry.eligibleAt,
  settlementId: entry.settlementId ?? null,
  note: entry.note ?? '',
  breakdown: ownerViewOfLine(entry.breakdown),
  createdAt: entry.createdAt,
});

/** A page of a restaurant's ledger, newest first, plus credit/debit totals for the filter. */
export const listLedger = async ({ restaurantId, type, from, to, page = 1, limit = 20 }) => {
  // An ObjectId, not a string: the totals below run through aggregate(), which doesn't cast.
  const filter = { restaurantId: new mongoose.Types.ObjectId(String(restaurantId)) };
  if (type) filter.type = type;
  if (from || to) {
    filter.eligibleAt = {};
    if (from) filter.eligibleAt.$gte = from;
    if (to) filter.eligibleAt.$lte = to;
  }

  const [entries, total, sums] = await Promise.all([
    RestaurantLedgerEntry.find(filter)
      .sort({ eligibleAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    RestaurantLedgerEntry.countDocuments(filter),
    RestaurantLedgerEntry.aggregate([
      { $match: filter },
      { $group: { _id: '$direction', amount: { $sum: '$amountPaise' } } },
    ]),
  ]);

  const credits = sums.find((s) => s._id === 'credit')?.amount ?? 0;
  const debits = sums.find((s) => s._id === 'debit')?.amount ?? 0;
  return { entries, total, page, limit, totals: { creditsPaise: credits, debitsPaise: debits, netPaise: credits - debits } };
};
