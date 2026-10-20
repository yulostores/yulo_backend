import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import Restaurant from '../models/Restaurant.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise } from '../utils/money.js';
import { weekBounds } from '../utils/week.js';
import {
  STATUSES_FOR_TRANSFER,
  eligibilityOf,
  failureLabelOf,
  holdLabelOf,
  orderPaymentStatusOf,
  ownerViewOf,
  transferOf,
} from '../utils/payoutStatus.js';
import { getActiveSettings } from './financeSettings.service.js';
import { computeRestaurantSettlementLine } from './settlementMath.service.js';
import { ownerViewOfSettlement } from './settlement.service.js';
import { calculationLines, clearanceQueue, displayNoOfBill, displayNoOfOrder } from './payoutView.service.js';
import { payoutAccountView } from './payoutAccount.service.js';

// What the restaurant portal's Payments & Payouts screens read (Figma owner frames, F5): the
// overview, payout history, one statement, one order's / bill's payment detail and the bank &
// payout settings card. Read-only, scoped to one restaurant, money in PAISE.
//
// Owner-safe by construction: every response is assembled field by field — never a spread of a
// ledger row, settlement, order or bill — so Razorpay's fee, Yulo's margin, rider pay, the staff-
// only hold note and admin ids can't reach the restaurant (test/b12-owner-payments.test.js scans
// every response for them).

const EARNING_TYPES = ['order_earning', 'dine_in_earning'];
const OPEN_STATUSES = ['draft', 'approved', 'processing', 'failed', 'on_hold'];
const REFUNDED_STATES = ['processing', 'processed'];
// How far back a status-filtered recent-orders list looks (the status is derived, not stored).
const FILTER_WINDOW = 500;

const signed = (e) => (e.direction === 'credit' ? e.amountPaise : -e.amountPaise);
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const clampPage = (page, limit, max = 100) => ({
  page: Math.max(1, Number(page) || 1),
  limit: Math.min(max, Math.max(1, Number(limit) || 20)),
});

const settingsZone = async () => {
  const settings = await getActiveSettings();
  return { settings, timezone: settings.settlementCycle?.timezone ?? 'Asia/Kolkata' };
};

const period = (s) => (s ? { start: s.periodStart, end: s.periodEnd } : null);

const ownSettlement = async (restaurantId, id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid statement id');
  const s = await RestaurantSettlement.findOne({ _id: id, restaurantId }).lean();
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Statement not found');
  return s;
};

// The statement the restaurant is waiting on: its most recent one not yet paid.
// "Next payout": the money actually on its way. A week carried forward (or auto-held because it
// ended negative) owes the restaurant nothing, so it never stands in for a real payout. Among
// the rest, the furthest along wins — with the bank, then scheduled (soonest date), then
// failed (awaiting a reschedule), then not scheduled / held — oldest week first within each.
const NEXT_PAYOUT_RANK = { processing: 0, approved: 1, failed: 2, draft: 3, on_hold: 3 };
const nextOpenStatement = async (restaurantId) => {
  const open = await RestaurantSettlement.find({
    restaurantId,
    status: { $in: OPEN_STATUSES },
    'totals.netPayable': { $gt: 0 },
    holdReason: { $ne: 'NEGATIVE_BALANCE_CARRIED_FORWARD' },
  }).lean();
  const time = (d) => (d ? new Date(d).getTime() : Infinity);
  return (
    open.sort(
      (x, y) =>
        NEXT_PAYOUT_RANK[x.status] - NEXT_PAYOUT_RANK[y.status] ||
        time(x.payout?.scheduledFor) - time(y.payout?.scheduledFor) ||
        new Date(x.periodStart) - new Date(y.periodStart)
    )[0] ?? null
  );
};

/** A statement's bank-transfer date: when it was paid, else the date it is scheduled for. */
const transferDateOf = (s) => {
  const t = transferOf(s);
  return t.status === 'paid' ? t.paidAt : t.scheduledFor;
};

const yuloMoneyOfRows = (rows) =>
  rows
    .filter((e) => EARNING_TYPES.includes(e.type))
    .reduce((n, e) => n + (e.breakdown?.yuloMoney?.platformFee ?? 0) + (e.breakdown?.yuloMoney?.deliveryCharge ?? 0), 0);

// ── Order / bill rows ─────────────────────────────────────────────────────────

const paymentTypeOfOrder = (o) => {
  const channel = o.paymentChannel ?? (o.paymentMethod === 'online' ? 'online' : o.paymentMethod === 'cash' ? 'cod' : null);
  if (channel === 'online') return 'online';
  if (channel === 'cod') return 'cod';
  return 'counter';
};
const paymentTypeOfBill = (b) => (b.paymentChannel === 'online' || b.paidBy === 'online' ? 'dine_in_online' : 'dine_in_counter');

const isOnline = (paymentType) => paymentType === 'online' || paymentType === 'dine_in_online';

const customerPaidOf = (doc, paymentType) => {
  if (paymentType === 'dine_in_counter' || paymentType === 'counter') return null; // paid at the restaurant, not via Yulo
  return doc.charges?.grandTotal ?? doc.paymentAmountPaise ?? (doc.grandTotal != null ? toPaise(doc.grandTotal) : null);
};

const isRefunded = (doc, rows) =>
  rows.some((e) => e.type === 'refund_gateway_fee') ||
  REFUNDED_STATES.includes(doc.refund?.status) ||
  doc.paymentStatus === 'refunded';

// What an order still in flight is expected to earn the restaurant (no ledger row yet).
const projectedNet = (doc, paymentType, settings) => {
  if (!isOnline(paymentType) || !doc.charges) return null;
  return computeRestaurantSettlementLine({ charges: doc.charges, paymentChannel: 'online', settings }).restaurantNet;
};

/**
 * One order or bill as a Payments table row. `rows` are its ledger rows, `settlements` a map of
 * the statements they are in.
 */
const paymentRow = ({ kind, doc, rows, settlements, settings, now }) => {
  const paymentType = kind === 'bill' ? paymentTypeOfBill(doc) : paymentTypeOfOrder(doc);
  const primary = rows.find((e) => EARNING_TYPES.includes(e.type) || e.type === 'counter_platform_fee') ?? null;
  const settlement = primary?.settlementId ? settlements.get(String(primary.settlementId)) ?? null : null;
  const status = isRefunded(doc, rows) ? 'refunded' : orderPaymentStatusOf(primary, settlement, now);
  return {
    kind,
    id: doc._id,
    displayNo: kind === 'bill' ? displayNoOfBill(doc) : displayNoOfOrder(doc),
    date: kind === 'bill' ? doc.paidAt ?? doc.closedAt ?? doc.createdAt : doc.createdAt,
    paymentType,
    counterMethod: paymentType === 'dine_in_counter' ? doc.paidBy ?? null : paymentType === 'counter' ? doc.paymentMethod ?? null : null,
    customerPaidPaise: customerPaidOf(doc, paymentType),
    youReceivePaise: rows.length ? rows.reduce((n, e) => n + signed(e), 0) : projectedNet(doc, paymentType, settings),
    status,
    statementId: primary?.settlementId ?? null,
  };
};

// The documents a restaurant's Payments tables list: orders other than dine-in rounds (a dine-in
// round is paid through its table's bill) that were paid online, refunded, or paid in cash /
// at the counter and delivered — and every paid bill.
const ORDER_FILTER = (restaurantId) => ({
  restaurantId,
  type: { $ne: 'dine_in' },
  $or: [{ paymentStatus: { $in: ['paid', 'refunded'] } }, { paymentChannel: { $in: ['counter', 'cod'] }, status: 'delivered' }],
});
const BILL_FILTER = (restaurantId) => ({ restaurantId, status: 'paid', type: 'dine_in' });

const ORDER_FIELDS = 'type createdAt status paymentStatus paymentChannel paymentMethod charges paymentAmountPaise grandTotal refund';
const BILL_FIELDS = 'billNumber tableNumber createdAt paidAt closedAt paidBy paymentChannel charges paymentAmountPaise grandTotal refund';

/** Rows for a set of orders and bills, with their ledger rows and statements resolved. */
const buildRows = async ({ orders, bills, settings, now = new Date() }) => {
  const [orderRows, billRows] = await Promise.all([
    orders.length ? RestaurantLedgerEntry.find({ orderId: { $in: orders.map((o) => o._id) } }).lean() : [],
    bills.length ? RestaurantLedgerEntry.find({ billId: { $in: bills.map((b) => b._id) } }).lean() : [],
  ]);
  const settlementIds = [...new Set([...orderRows, ...billRows].map((e) => e.settlementId).filter(Boolean).map(String))];
  const settlements = new Map(
    (settlementIds.length ? await RestaurantSettlement.find({ _id: { $in: settlementIds } }).lean() : []).map((s) => [String(s._id), s])
  );
  const byKey = new Map();
  for (const e of [...orderRows, ...billRows]) {
    const k = e.orderId ? `o${e.orderId}` : `b${e.billId}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  return [
    ...orders.map((doc) => paymentRow({ kind: 'order', doc, rows: byKey.get(`o${doc._id}`) ?? [], settlements, settings, now })),
    ...bills.map((doc) => paymentRow({ kind: 'bill', doc, rows: byKey.get(`b${doc._id}`) ?? [], settlements, settings, now })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));
};

const recentOrders = async (restaurantId, { status, page, limit, settings }) => {
  const { page: p, limit: l } = clampPage(page, limit);
  const window = status ? FILTER_WINDOW : p * l;
  const [orders, bills, orderCount, billCount] = await Promise.all([
    Order.find(ORDER_FILTER(restaurantId)).select(ORDER_FIELDS).sort({ createdAt: -1 }).limit(window).lean(),
    Bill.find(BILL_FILTER(restaurantId)).select(BILL_FIELDS).sort({ paidAt: -1, createdAt: -1 }).limit(window).lean(),
    Order.countDocuments(ORDER_FILTER(restaurantId)),
    Bill.countDocuments(BILL_FILTER(restaurantId)),
  ]);
  let rows = await buildRows({ orders, bills, settings });
  let total = orderCount + billCount;
  if (status) {
    rows = rows.filter((r) => r.status === status);
    total = rows.length;
  }
  return { rows: rows.slice((p - 1) * l, p * l), total, page: p, limit: l };
};

// ── Overview ──────────────────────────────────────────────────────────────────

const destinationOf = (restaurant) => {
  const a = payoutAccountView(restaurant);
  return {
    last4: a.accountNumberLast4,
    status: a.status,
    holderName: a.accountHolderName,
    frequency: 'weekly',
    hasPendingChange: a.hasPendingChange,
  };
};

const nextPayoutView = (s, timezone) =>
  s
    ? {
        statementId: s._id,
        period: period(s),
        netPaise: s.totals?.netPayable ?? 0,
        eligibility: eligibilityOf(s),
        transferStatus: transferOf(s).status,
        scheduledFor: transferOf(s).scheduledFor,
        holdLabel: holdLabelOf(s),
        ownerView: ownerViewOf(s, { timezone }),
      }
    : null;

/**
 * GET …/payments/overview. The period (for "Yulo money this week" and the toolbar) is the chosen
 * statement's week, else the week containing `weekStart`, else the current week.
 */
export const overview = async (restaurantId, { statementId, weekStart, status, page, limit, now = new Date() } = {}) => {
  const rid = oid(restaurantId);
  const { settings, timezone } = await settingsZone();
  const restaurant = await Restaurant.findById(rid).select('name payoutAccount documents').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  let selected = null;
  if (statementId) selected = await ownSettlement(rid, statementId);
  const bounds = selected
    ? { start: selected.periodStart, end: selected.periodEnd }
    : weekBounds(weekStart ? new Date(weekStart) : now, settings.settlementCycle);

  const [next, statements, periodRows, clearing, orders, settlementCount, entryCount] = await Promise.all([
    nextOpenStatement(rid),
    RestaurantSettlement.find({ restaurantId: rid }).select('periodStart periodEnd status payout totals').sort({ periodStart: -1 }).limit(52).lean(),
    RestaurantLedgerEntry.find({ restaurantId: rid, type: { $in: EARNING_TYPES }, eligibleAt: { $gte: bounds.start, $lte: bounds.end } })
      .select('type breakdown')
      .lean(),
    clearanceQueue({ restaurantId: rid, page: 1, limit: 1, now }),
    recentOrders(rid, { status, page, limit, settings }),
    RestaurantSettlement.countDocuments({ restaurantId: rid }),
    RestaurantLedgerEntry.countDocuments({ restaurantId: rid }),
  ]);

  const isEmpty = settlementCount === 0 && entryCount === 0 && clearing.totals.count === 0 && orders.total === 0;
  return {
    isEmpty,
    period: { start: bounds.start, end: bounds.end },
    selectedStatementId: selected?._id ?? null,
    nextPayout: nextPayoutView(next, timezone),
    nextPayoutReason: next ? null : entryCount > 0 || settlementCount > 0 ? 'no_open_statement' : 'no_eligible_earnings',
    stillClearing: { amountPaise: clearing.totals.expectedPayoutPaise, orderCount: clearing.totals.count },
    yuloMoney: { amountPaise: yuloMoneyOfRows(periodRows), periodStart: bounds.start, periodEnd: bounds.end },
    payoutDestination: destinationOf(restaurant),
    statements: statements.map((s) => ({ statementId: s._id, period: period(s), transferStatus: transferOf(s).status, netPaise: s.totals?.netPayable ?? 0 })),
    recentOrders: orders,
  };
};

// ── Payout history ────────────────────────────────────────────────────────────

const dateRangeFilter = ({ from, to }) => {
  if (!from && !to) return {};
  const f = {};
  if (from) f.$gte = new Date(from);
  if (to) f.$lte = new Date(to);
  return { periodStart: f };
};

export const history = async (restaurantId, { transferStatus, from, to, page, limit } = {}) => {
  const rid = oid(restaurantId);
  const { timezone } = await settingsZone();
  const { page: p, limit: l } = clampPage(page, limit);
  const base = { restaurantId: rid, ...dateRangeFilter({ from, to }) };
  const filter = transferStatus ? { ...base, status: { $in: STATUSES_FOR_TRANSFER[transferStatus] ?? [] } } : base;

  const [rows, total, paidAgg, available, next] = await Promise.all([
    RestaurantSettlement.find(filter).sort({ periodStart: -1 }).skip((p - 1) * l).limit(l).lean(),
    RestaurantSettlement.countDocuments(filter),
    RestaurantSettlement.aggregate([{ $match: { ...base, status: 'paid' } }, { $group: { _id: null, total: { $sum: '$totals.netPayable' } } }]),
    RestaurantSettlement.countDocuments({ ...base, entryCount: { $gt: 0 } }),
    nextOpenStatement(rid),
  ]);
  return {
    kpis: {
      totalPaidPaise: paidAgg[0]?.total ?? 0,
      upcomingEligible: next ? { statementId: next._id, netPaise: next.totals?.netPayable ?? 0, scheduledFor: transferOf(next).scheduledFor } : null,
      availableStatements: available,
    },
    rows: rows.map((s) => ({
      statementId: s._id,
      period: period(s),
      transferDate: transferDateOf(s),
      netPayoutPaise: s.totals?.netPayable ?? 0,
      transferStatus: transferOf(s).status,
      eligibility: eligibilityOf(s),
      ownerView: ownerViewOf(s, { timezone }),
    })),
    total,
    page: p,
    limit: l,
  };
};

// ── Statement & payout detail ─────────────────────────────────────────────────

const timelineOf = (s) => {
  const t = transferOf(s);
  const p = s.payout ?? {};
  const steps = [
    { key: 'prepared', label: 'Statement prepared', done: true, at: s.generatedAt ?? s.createdAt ?? null },
    { key: 'eligible', label: 'Settlement eligible', done: s.status !== 'on_hold', at: s.clearedAt ?? null },
  ];
  if (s.status === 'on_hold') steps.push({ key: 'on_hold', label: holdLabelOf(s) ?? 'On hold', done: true, at: s.heldAt ?? null });
  steps.push(
    {
      key: 'scheduled',
      label: 'Scheduled',
      done: ['approved', 'processing', 'paid', 'failed'].includes(s.status),
      at: p.scheduledAt ?? null,
      date: t.scheduledFor ?? p.scheduledFor ?? null,
    },
    { key: 'released', label: 'Sent to the bank', done: ['processing', 'paid', 'failed'].includes(s.status), at: t.releasedAt }
  );
  if (t.lastFailure) {
    steps.push({ key: 'failed', label: 'Bank rejected the credit', done: true, at: t.lastFailure.at, reasonLabel: failureLabelOf(p.lastFailure) });
  }
  steps.push({ key: 'paid', label: 'Paid to your bank', done: s.status === 'paid', at: t.paidAt });
  return steps;
};

export const statementDetail = async (restaurantId, id) => {
  const rid = oid(restaurantId);
  const { settings, timezone } = await settingsZone();
  const s = await ownSettlement(rid, id);
  const [entries, restaurant] = await Promise.all([
    RestaurantLedgerEntry.find({ settlementId: s._id }).sort({ eligibleAt: 1, _id: 1 }).lean(),
    Restaurant.findById(rid).select('gstRegistered payoutAccount.accountNumberLast4').lean(),
  ]);
  const orderIds = [...new Set(entries.filter((e) => e.orderId).map((e) => String(e.orderId)))];
  const billIds = [...new Set(entries.filter((e) => e.billId).map((e) => String(e.billId)))];
  const [orders, bills] = await Promise.all([
    orderIds.length ? Order.find({ _id: { $in: orderIds }, restaurantId: rid }).select(ORDER_FIELDS).lean() : [],
    billIds.length ? Bill.find({ _id: { $in: billIds }, restaurantId: rid }).select(BILL_FIELDS).lean() : [],
  ]);
  const transfer = transferOf(s);
  const owner = ownerViewOfSettlement(s, { timezone });
  return {
    statement: {
      statementId: s._id,
      period: period(s),
      eligibility: eligibilityOf(s),
      transfer: owner.transfer,
      holdLabel: holdLabelOf(s),
      destinationLast4: s.payout?.beneficiary?.accountNumberLast4 ?? restaurant?.payoutAccount?.accountNumberLast4 ?? null,
      bankReference: transfer.bankReference,
      transferDate: transferDateOf(s),
      netPayoutPaise: s.totals?.netPayable ?? 0,
      clearedAt: s.clearedAt ?? null,
      entryCount: s.entryCount ?? entries.length,
    },
    ownerView: owner.ownerView,
    timeline: timelineOf(s),
    yuloMoneyPaise: (s.totals?.yuloMoneyPlatformFee ?? 0) + (s.totals?.yuloMoneyDelivery ?? 0),
    calculation: calculationLines(s, entries, { gstRegistered: restaurant?.gstRegistered !== false }),
    otherFeeCategories: otherFeeCategories(s.totals),
    orders: await buildRows({ orders, bills, settings }),
    hasEntries: entries.length > 0,
  };
};

const otherFeeCategories = (t = {}) => [
  { key: 'restaurantPlatform', label: 'Restaurant platform', amountPaise: t.planCharges ?? 0 },
  { key: 'ads', label: 'Ads', amountPaise: t.adCharges ?? 0 },
  { key: 'penalties', label: 'Other deductions / penalties', amountPaise: t.penalties ?? 0 },
];

// ── Order / bill payment detail ───────────────────────────────────────────────

// The customer's bill, from the frozen charges (never recomputed on the client).
const customerBillOf = (doc, paymentType) => {
  const c = doc.charges;
  if (paymentType === 'dine_in_counter') {
    return { paidAtTable: true, counterMethod: doc.paidBy ?? null, lines: c?.lines ?? [], paidAmountPaise: null };
  }
  if (!c) {
    return { paidAtTable: false, lines: [], paidAmountPaise: customerPaidOf(doc, paymentType) };
  }
  const lines = [];
  lines.push({ key: 'price', label: 'Price', amountPaise: c.food?.subtotal ?? 0 });
  if (c.food?.discount) lines.push({ key: 'discount', label: 'Coupon discount', amountPaise: -c.food.discount });
  if (c.food?.gst) lines.push({ key: 'gst', label: `GST (${c.food.gstPercent ?? 0}%)`, amountPaise: c.food.gst });
  if (c.delivery && !c.delivery.pending) {
    lines.push({
      key: 'delivery',
      label: 'Delivery partner charges',
      amountPaise: c.delivery.customerPays ?? 0,
      basePaise: c.delivery.paidBy === 'restaurant' ? 0 : c.delivery.base ?? 0,
      gstPaise: c.delivery.paidBy === 'restaurant' ? 0 : c.delivery.gst ?? 0,
      freeDelivery: c.delivery.paidBy === 'restaurant',
    });
  }
  if (c.serviceCharge) lines.push({ key: 'serviceCharge', label: 'Service charge', amountPaise: c.serviceCharge });
  if (c.platformFee?.total) {
    lines.push({
      key: 'platformFee',
      label: 'Customer platform charges',
      amountPaise: c.platformFee.total,
      basePaise: c.platformFee.base,
      gstPaise: c.platformFee.gst,
    });
  }
  if (c.tip) lines.push({ key: 'tip', label: 'Delivery partner tip', amountPaise: c.tip });
  if (c.roundOff) lines.push({ key: 'roundOff', label: 'Round off', amountPaise: c.roundOff });
  return { paidAtTable: false, lines, paidAmountPaise: c.grandTotal ?? null };
};

// The restaurant's side of one order / bill: from its ledger row's breakdown when it has one,
// else a projection from the frozen charges (an order still in flight).
const restaurantSettlementOf = ({ rows, doc, paymentType, settings }) => {
  const primary = rows.find((e) => EARNING_TYPES.includes(e.type) || e.type === 'counter_platform_fee');
  const refundFee = rows.find((e) => e.type === 'refund_gateway_fee');
  let b = primary?.breakdown ?? null;
  let projected = false;
  if (!b && isOnline(paymentType) && doc.charges && !refundFee) {
    b = computeRestaurantSettlementLine({ charges: doc.charges, paymentChannel: 'online', settings });
    projected = true;
  }
  const lines = [];
  if (b) {
    const counter = paymentType === 'dine_in_counter' || paymentType === 'counter';
    if (!counter) {
      const price = (b.customerPaid ?? 0) - (b.yuloMoney?.platformFee ?? 0) - (b.yuloMoney?.deliveryCharge ?? 0) - (b.tip ?? 0);
      lines.push({ key: 'priceInclGst', label: 'Price incl GST', amountPaise: price });
    } else {
      lines.push({ key: 'platformFee', label: 'Platform fee (paid at table)', amountPaise: -(b.yuloMoney?.platformFee ?? 0) });
    }
    const sc = b.settlementCharge ?? {};
    const onAmount = counter
      ? b.yuloMoney?.platformFee ?? 0
      : settings.settlementChargeBase === 'restaurant_share'
        ? (b.customerPaid ?? 0) - (b.tip ?? 0) - (b.yuloMoney?.platformFee ?? 0) - (b.yuloMoney?.deliveryCharge ?? 0)
        : (b.customerPaid ?? 0) - (b.tip ?? 0);
    lines.push({
      key: 'settlementFee',
      label: 'Payment settlement fee',
      amountPaise: -(sc.total ?? 0),
      percent: sc.percent ?? settings.settlementChargePercent,
      onAmountPaise: onAmount,
      basePaise: sc.base ?? 0,
      gstPaise: sc.gst ?? 0,
    });
    if (b.restaurantBorneDelivery) lines.push({ key: 'freeDelivery', label: 'Free delivery', amountPaise: -b.restaurantBorneDelivery });
    const other = (b.planCharge ?? 0) + (b.adCharge ?? 0) + (b.penalty ?? 0);
    lines.push({ key: 'otherDeductions', label: 'Other deductions', amountPaise: -other });
  }
  if (refundFee) lines.push({ key: 'refundAdjustment', label: 'Refund adjustment', amountPaise: signed(refundFee) });
  const received = rows.length ? rows.reduce((n, e) => n + signed(e), 0) : b ? b.restaurantNet : null;
  return { projected, lines, receivedPaise: received };
};

const stageOf = ({ doc, kind, paymentType, primary, settlement, status, now }) => {
  if (status === 'refunded') return 'refunded';
  if (paymentType === 'dine_in_counter' || paymentType === 'counter') return settlement ? (settlement.status === 'paid' ? 'settled' : 'in_statement') : 'counter';
  if (!primary) return kind === 'order' && doc.status !== 'delivered' ? 'awaiting_delivery' : 'clearing';
  if (settlement) return settlement.status === 'paid' ? 'settled' : 'in_statement';
  const clearsAt = primary.clearsAt ?? primary.eligibleAt;
  return clearsAt && new Date(clearsAt) > now ? 'clearing' : 'eligible';
};

const refundSummaryOf = (doc) =>
  doc.refund?.status && doc.refund.status !== 'none'
    ? {
        status: doc.refund.status,
        amountPaise: doc.refund.amountPaise ?? null,
        reason: doc.refund.reason ?? null,
        initiatedAt: doc.refund.initiatedAt ?? null,
        processedAt: doc.refund.processedAt ?? null,
      }
    : null;

export const paymentDetail = async (restaurantId, kind, id, { now = new Date() } = {}) => {
  const rid = oid(restaurantId);
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${kind} id`);
  const { settings, timezone } = await settingsZone();
  const Model = kind === 'bill' ? Bill : Order;
  const doc = await Model.findOne({ _id: id, restaurantId: rid })
    .select(kind === 'bill' ? `${BILL_FIELDS} type status` : `${ORDER_FIELDS} paidAt deliveredAt`)
    .lean();
  if (!doc) throw new ApiError(404, 'NOT_FOUND', kind === 'bill' ? 'Bill not found' : 'Order not found');

  const rows = await RestaurantLedgerEntry.find(kind === 'bill' ? { billId: doc._id } : { orderId: doc._id }).lean();
  const primary = rows.find((e) => EARNING_TYPES.includes(e.type) || e.type === 'counter_platform_fee') ?? null;
  const settlement = primary?.settlementId ? await RestaurantSettlement.findById(primary.settlementId).lean() : null;
  const paymentType = kind === 'bill' ? paymentTypeOfBill(doc) : paymentTypeOfOrder(doc);
  const status = isRefunded(doc, rows) ? 'refunded' : orderPaymentStatusOf(primary, settlement, now);
  const contribution = settlement ? rows.filter((e) => String(e.settlementId) === String(settlement._id)).reduce((n, e) => n + signed(e), 0) : null;
  const online = isOnline(paymentType);

  return {
    kind,
    id: doc._id,
    displayNo: kind === 'bill' ? displayNoOfBill(doc) : displayNoOfOrder(doc),
    tableNumber: kind === 'bill' ? doc.tableNumber ?? null : null,
    orderType: kind === 'bill' ? 'dine_in' : doc.type,
    date: kind === 'bill' ? doc.paidAt ?? doc.createdAt : doc.createdAt,
    paymentType,
    status,
    customerBill: customerBillOf(doc, paymentType),
    restaurantSettlement: restaurantSettlementOf({ rows, doc, paymentType, settings }),
    otherFeeCategories: otherFeeCategories({
      planCharges: primary?.breakdown?.planCharge,
      adCharges: primary?.breakdown?.adCharge,
      penalties: primary?.breakdown?.penalty,
    }),
    clearance: {
      stage: stageOf({ doc, kind, paymentType, primary, settlement, status, now }),
      paidAt: online ? doc.paidAt ?? doc.createdAt ?? null : kind === 'bill' ? doc.paidAt ?? null : null,
      clearsAt: primary?.clearsAt ?? primary?.eligibleAt ?? null,
      eligibleAt: primary?.eligibleAt ?? null,
      scheduledFor: settlement ? transferOf(settlement).scheduledFor : null,
    },
    linkedStatement: settlement
      ? { statementId: settlement._id, period: period(settlement), netPayoutPaise: settlement.totals?.netPayable ?? 0, contributionPaise: contribution }
      : null,
    // Customer-paid platform fee + delivery charge — a counter bill's platform fee is the
    // restaurant's own debit, not Yulo money.
    yuloMoneyPaise: online && doc.charges ? (doc.charges.platformFee?.total ?? 0) + (doc.charges.delivery?.customerPays ?? 0) : 0,
    refund: refundSummaryOf(doc),
    ownerView: settlement ? ownerViewOf(settlement, { timezone }) : null,
  };
};

// ── Bank & payout settings ────────────────────────────────────────────────────

export const payoutSettings = async (restaurantId) => {
  const rid = oid(restaurantId);
  const restaurant = await Restaurant.findById(rid).select('payoutAccount documents').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const a = payoutAccountView(restaurant);
  const scheduled = await RestaurantSettlement.findOne({ restaurantId: rid, status: 'approved' }).sort({ 'payout.scheduledFor': 1 }).lean();
  return {
    account: {
      status: a.status,
      accountHolderName: a.accountHolderName,
      accountNumberLast4: a.accountNumberLast4,
      accountNumberMasked: a.accountNumberMasked,
      rejectionReason: a.rejectionReason,
      verifiedAt: a.verifiedAt,
      proofDocument: a.proofDocument,
      pendingChange: a.pendingChange
        ? {
            status: a.pendingChange.status,
            accountNumberLast4: a.pendingChange.accountNumberLast4 ?? null,
            requestedAt: a.pendingChange.requestedAt ?? null,
            infoRequest: a.pendingChange.infoRequest?.message
              ? { message: a.pendingChange.infoRequest.message, at: a.pendingChange.infoRequest.at ?? null }
              : null,
            rejectionReason: a.pendingChange.rejectionReason ?? null,
          }
        : null,
      hasPendingChange: a.hasPendingChange,
    },
    frequency: 'weekly',
    nextScheduledPayout: scheduled
      ? {
          statementId: scheduled._id,
          period: period(scheduled),
          netPaise: scheduled.totals?.netPayable ?? 0,
          scheduledFor: scheduled.payout?.scheduledFor ?? null,
          destinationLast4: scheduled.payout?.beneficiary?.accountNumberLast4 ?? a.accountNumberLast4,
        }
      : null,
  };
};
