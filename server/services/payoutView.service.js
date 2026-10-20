import mongoose from 'mongoose';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Restaurant from '../models/Restaurant.js';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import SupportTicket from '../models/SupportTicket.js';
import { ApiError } from '../utils/ApiError.js';
import { weekBounds } from '../utils/week.js';
import {
  HOLD_REASONS,
  STATUSES_FOR_TRANSFER,
  eligibilityOf,
  holdLabelOf,
  orderPaymentStatusOf,
  ownerViewOf,
  transferOf,
} from '../utils/payoutStatus.js';
import { getActiveSettings } from './financeSettings.service.js';
import { computeRestaurantSettlementLine } from './settlementMath.service.js';
import { previousWeekStart } from './settlement.service.js';

// What the super admin's Restaurant Payouts screens read (Figma S1–S5, D1–D6): the weekly batch,
// the clearance queue, the payout history and one payout's detail. Read-only — every change goes
// through settlement.service.js. Money in PAISE; statuses are the two axes of utils/payoutStatus.js.

const EARNING_TYPES = ['order_earning', 'dine_in_earning'];
const OPEN_TICKET_STATUSES = ['open', 'in_review', 'awaiting_restaurant'];

const signed = (e) => (e.direction === 'credit' ? e.amountPaise : -e.amountPaise);
const shortCode = (id) => (id ? String(id).slice(-6).toUpperCase() : null);
export const displayNoOfOrder = (o) => (o ? `#${shortCode(o._id)}` : null);
export const displayNoOfBill = (b) => (b ? b.billNumber ?? `#${shortCode(b._id)}` : null);

const settingsZone = async () => {
  const settings = await getActiveSettings();
  return { settings, timezone: settings.settlementCycle?.timezone ?? 'Asia/Kolkata' };
};

/** The food the customers paid for (incl. its GST) in a set of rows — what deductions come off. */
export const foodInclGstOf = (entries) =>
  entries
    .filter((e) => EARNING_TYPES.includes(e.type))
    .reduce((n, e) => {
      const b = e.breakdown ?? {};
      return n + (b.customerPaid ?? 0) - (b.yuloMoney?.platformFee ?? 0) - (b.yuloMoney?.deliveryCharge ?? 0) - (b.tip ?? 0);
    }, 0);

/**
 * "How this is calculated" — the statement's lines in the design's labels (owner-safe: no
 * Razorpay fee, margin or rider pay). Signed paise; zero-value optional lines are left out. The
 * lines always add up to the net payout.
 */
export const calculationLines = (settlement, entries, { gstRegistered = true } = {}) => {
  const t = settlement.totals ?? {};
  const food = foodInclGstOf(entries);
  const lines = [
    { key: 'food', label: gstRegistered ? 'Food incl. GST' : 'Food', amountPaise: food },
    { key: 'freeDelivery', label: 'Free delivery', amountPaise: -(t.restaurantBorneDelivery ?? 0) },
    { key: 'settlementFees', label: 'Settlement fees', amountPaise: -(t.settlementCharge?.total ?? 0) },
    { key: 'dineInDues', label: 'Dine-in dues', amountPaise: -(t.counterPlatformFees ?? 0) },
    { key: 'refundAdjustment', label: 'Refund adjustment', amountPaise: -(t.refundGatewayFees ?? 0) },
  ];
  const optional = [
    { key: 'adjustments', label: 'Adjustments', amountPaise: (t.adjustments ?? 0) - (t.penalties ?? 0) },
    { key: 'carriedIn', label: 'Carried forward from earlier weeks', amountPaise: (t.carryForwardIn ?? 0) + (t.failedPayoutsCarriedIn ?? 0) },
    { key: 'carriedOut', label: 'Carried forward to next week', amountPaise: t.carryForwardOut ?? 0 },
  ].filter((l) => l.amountPaise !== 0);
  lines.push(...optional);
  // Anything a future row type adds that the lines above don't name — never silently lost.
  const rest = (t.netPayable ?? 0) - lines.reduce((n, l) => n + l.amountPaise, 0);
  if (rest !== 0) lines.push({ key: 'other', label: 'Other', amountPaise: rest });
  return { lines, netPayoutPaise: t.netPayable ?? 0 };
};

const nextActionOf = (s) =>
  ({
    draft: 'schedule',
    approved: 'review',
    processing: 'record_result',
    failed: 'reschedule',
    on_hold: s.holdReason === 'MANUAL' ? 'review_hold' : 'review',
    paid: 'view',
    carried_forward: 'view',
  })[s.status] ?? 'view';

// Ledger rows per settlement: counts by kind (order, dine-in, refund…) and food incl. GST.
const rowStatsBySettlement = async (settlementIds) => {
  if (!settlementIds.length) return new Map();
  const entries = await RestaurantLedgerEntry.find({ settlementId: { $in: settlementIds } })
    .select('settlementId type direction amountPaise breakdown')
    .lean();
  const map = new Map();
  for (const e of entries) {
    const k = String(e.settlementId);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  const stats = new Map();
  for (const [k, list] of map) {
    stats.set(k, {
      foodInclGst: foodInclGstOf(list),
      orders: list.filter((e) => e.type === 'order_earning').length,
      dineInBills: list.filter((e) => e.type === 'dine_in_earning').length,
      dineInAdjustments: list.filter((e) => e.type === 'counter_platform_fee').length,
      refunds: list.filter((e) => e.type === 'refund_gateway_fee').length,
    });
  }
  return stats;
};

const restaurantsById = async (ids) => {
  const list = await Restaurant.find({ _id: { $in: ids } }).select('name gstRegistered').lean();
  return new Map(list.map((r) => [String(r._id), r]));
};

// ── Clearance queue (S3) ──────────────────────────────────────────────────────

/**
 * Online money that hasn't cleared: orders paid online but not yet delivered, and ledger rows
 * (delivered orders, paid bills) still inside Razorpay's T+2. One row per order or bill, not
 * scoped to a week. `restaurantId` limits it to one restaurant (the owner's "Still clearing").
 */
export const clearanceQueue = async ({ restaurantId, page = 1, limit = 20, now = new Date() } = {}) => {
  const scope = restaurantId ? { restaurantId: new mongoose.Types.ObjectId(String(restaurantId)) } : {};
  const { settings } = await settingsZone();

  const [undelivered, clearing] = await Promise.all([
    Order.find({
      ...scope,
      type: { $ne: 'dine_in' },
      paymentStatus: 'paid',
      $or: [{ paymentChannel: 'online' }, { paymentChannel: { $in: [null] }, paymentMethod: 'online' }],
      status: { $nin: ['delivered', 'cancelled'] },
    })
      .select('restaurantId type createdAt charges paymentAmountPaise grandTotal +razorpayFee +razorpayTax')
      .lean(),
    RestaurantLedgerEntry.find({ ...scope, settlementId: null, type: { $in: EARNING_TYPES }, clearsAt: { $gt: now } }).lean(),
  ]);

  const orderIds = clearing.filter((e) => e.orderId).map((e) => e.orderId);
  const billIds = clearing.filter((e) => e.billId).map((e) => e.billId);
  const [orders, bills] = await Promise.all([
    Order.find({ _id: { $in: orderIds } }).select('createdAt charges paymentAmountPaise').lean(),
    Bill.find({ _id: { $in: billIds } }).select('billNumber createdAt charges paymentAmountPaise').lean(),
  ]);
  const orderMap = new Map(orders.map((o) => [String(o._id), o]));
  const billMap = new Map(bills.map((b) => [String(b._id), b]));

  const rows = [
    ...undelivered.map((o) => {
      let expected = null;
      if (o.charges) {
        expected = computeRestaurantSettlementLine({
          charges: o.charges,
          paymentChannel: 'online',
          razorpayFeePaise: o.razorpayFee ?? 0,
          razorpayTaxPaise: o.razorpayTax ?? 0,
          settings,
        }).restaurantNet;
      }
      return {
        kind: 'order',
        id: o._id,
        displayNo: displayNoOfOrder(o),
        restaurantId: o.restaurantId,
        placedAt: o.createdAt,
        customerPaidPaise: o.charges?.grandTotal ?? o.paymentAmountPaise ?? null,
        expectedPayoutPaise: expected,
        clearsAt: null, // after delivery + T+2
        stage: 'awaiting_delivery',
        eligibility: 'pending',
        statementId: null,
      };
    }),
    ...clearing.map((e) => {
      const doc = e.orderId ? orderMap.get(String(e.orderId)) : billMap.get(String(e.billId));
      return {
        kind: e.orderId ? 'order' : 'bill',
        id: e.orderId ?? e.billId,
        displayNo: e.orderId ? displayNoOfOrder(doc ?? { _id: e.orderId }) : displayNoOfBill(doc ?? { _id: e.billId }),
        restaurantId: e.restaurantId,
        placedAt: doc?.createdAt ?? e.createdAt,
        customerPaidPaise: e.breakdown?.customerPaid ?? doc?.charges?.grandTotal ?? null,
        expectedPayoutPaise: signed(e),
        clearsAt: e.clearsAt,
        stage: 'clearing',
        eligibility: 'pending',
        statementId: null,
      };
    }),
  ].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));

  const restaurants = await restaurantsById([...new Set(rows.map((r) => String(r.restaurantId)))]);
  const totals = {
    count: rows.length,
    expectedPayoutPaise: rows.reduce((n, r) => n + (r.expectedPayoutPaise ?? 0), 0),
    customerPaidPaise: rows.reduce((n, r) => n + (r.customerPaidPaise ?? 0), 0),
    restaurants: restaurants.size,
  };
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  return {
    rows: rows.slice((p - 1) * l, p * l).map((r) => ({
      ...r,
      restaurant: restaurants.has(String(r.restaurantId)) ? { _id: r.restaurantId, name: restaurants.get(String(r.restaurantId)).name } : null,
    })),
    totals,
    page: p,
    limit: l,
  };
};

// ── Tab counts ────────────────────────────────────────────────────────────────

const tabCounts = async (clearanceCount) => {
  let bankRequests = 0;
  try {
    const mod = await import('./payoutAccount.service.js');
    if (typeof mod.countOpenBankRequests === 'function') bankRequests = (await mod.countOpenBankRequests())?.open ?? 0;
  } catch {
    bankRequests = 0;
  }
  const paymentIssues = await SupportTicket.countDocuments({ kind: 'payment', status: { $in: OPEN_TICKET_STATUSES } });
  return { clearanceQueue: clearanceCount, bankRequests, paymentIssues };
};

// ── Weekly batch (S1 / S2) ────────────────────────────────────────────────────

/** Every restaurant's payout for one week (default: the last week that ended), with the KPIs. */
export const weeklyBatch = async ({ weekStart } = {}) => {
  const { settings } = await settingsZone();
  const at = weekStart ? new Date(weekStart) : previousWeekStart(new Date(), settings.settlementCycle);
  const { start: periodStart, end: periodEnd } = weekBounds(at, settings.settlementCycle);

  const settlements = await RestaurantSettlement.find({ periodStart }).sort({ 'totals.netPayable': -1 }).lean();
  const [stats, restaurants, clearance] = await Promise.all([
    rowStatsBySettlement(settlements.map((s) => s._id)),
    restaurantsById(settlements.map((s) => s.restaurantId)),
    clearanceQueue({ limit: 1 }),
  ]);

  const rows = settlements.map((s) => {
    const st = stats.get(String(s._id)) ?? { foodInclGst: 0, orders: 0, dineInBills: 0, dineInAdjustments: 0, refunds: 0 };
    const r = restaurants.get(String(s.restaurantId));
    return {
      settlementId: s._id,
      restaurant: { _id: s.restaurantId, name: r?.name ?? null, gstRegistered: r?.gstRegistered ?? null },
      foodInclGstPaise: st.foodInclGst,
      deductionsPaise: st.foodInclGst - s.totals.netPayable,
      netPayablePaise: s.totals.netPayable,
      eligibility: eligibilityOf(s),
      transfer: transferOf(s),
      holdLabel: holdLabelOf(s),
      nextAction: nextActionOf(s),
      counts: { orders: st.orders + st.dineInBills, dineInAdjustments: st.dineInAdjustments, refunds: st.refunds },
    };
  });

  const sum = (list) => list.reduce((n, s) => n + s.totals.netPayable, 0);
  const held = settlements.filter((s) => s.status === 'on_hold');
  const ready = settlements.filter((s) => s.status === 'approved');
  const kpis = {
    batchTotal: {
      amountPaise: sum(settlements.filter((s) => s.status !== 'carried_forward')),
      restaurants: settlements.length,
      orders: rows.reduce((n, r) => n + r.counts.orders, 0),
    },
    readyToRelease: { amountPaise: sum(ready), restaurants: ready.length },
    onHold: { amountPaise: sum(held), restaurants: held.length, reasons: [...new Set(held.map(holdLabelOf).filter(Boolean))] },
    awaitingClearance: { amountPaise: clearance.totals.expectedPayoutPaise, orders: clearance.totals.count },
  };
  return { periodStart, periodEnd, kpis, rows, tabCounts: await tabCounts(clearance.totals.count) };
};

// ── Payout history (S4) ───────────────────────────────────────────────────────

const historyFilter = ({ restaurantId, from, to }) => {
  const filter = {};
  if (restaurantId) filter.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
  if (from || to) {
    filter.periodStart = {};
    if (from) filter.periodStart.$gte = new Date(from);
    if (to) filter.periodStart.$lte = new Date(to);
  }
  return filter;
};

const historyRow = (s, restaurants) => {
  const transfer = transferOf(s);
  return {
    settlementId: s._id,
    restaurant: { _id: s.restaurantId, name: restaurants.get(String(s.restaurantId))?.name ?? null },
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    netPayoutPaise: s.totals.netPayable,
    eligibility: eligibilityOf(s),
    transfer,
    transferDate: transfer.status === 'paid' ? transfer.paidAt : s.payout?.scheduledFor ?? null,
    bankReference: transfer.bankReference,
  };
};

/**
 * Every statement and its bank transfer, newest first. KPIs cover the restaurant / date filter
 * (all transfer statuses); `transferStatus` narrows the rows only.
 */
export const payoutHistory = async ({ restaurantId, transferStatus, from, to, page = 1, limit = 20 } = {}) => {
  const base = historyFilter({ restaurantId, from, to });
  const filter = { ...base };
  if (transferStatus) {
    const statuses = STATUSES_FOR_TRANSFER[transferStatus];
    if (!statuses) throw new ApiError(400, 'VALIDATION_ERROR', `transferStatus must be one of ${Object.keys(STATUSES_FOR_TRANSFER).join(', ')}`);
    filter.status = { $in: statuses };
  }
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const [settlements, total, all] = await Promise.all([
    RestaurantSettlement.find(filter).sort({ periodStart: -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    RestaurantSettlement.countDocuments(filter),
    RestaurantSettlement.find(base).select('status totals.netPayable payout.scheduledFor').lean(),
  ]);
  const restaurants = await restaurantsById(settlements.map((s) => s.restaurantId));
  const pick = (statuses) => all.filter((s) => statuses.includes(s.status));
  const paid = pick(['paid']);
  const scheduled = pick(['approved']);
  const notScheduled = pick(['draft']);
  const nextDate = scheduled.map((s) => s.payout?.scheduledFor).filter(Boolean).sort((a, b) => new Date(a) - new Date(b))[0] ?? null;
  const amount = (list) => list.reduce((n, s) => n + s.totals.netPayable, 0);
  return {
    kpis: {
      paid: { amountPaise: amount(paid), count: paid.length },
      scheduled: { amountPaise: amount(scheduled), count: scheduled.length, nextDate },
      notYetScheduled: { amountPaise: amount(notScheduled), count: notScheduled.length },
    },
    rows: settlements.map((s) => historyRow(s, restaurants)),
    total,
    page: p,
    limit: l,
  };
};

/** The filtered history as CSV rows (every page). */
export const payoutHistoryForExport = async ({ restaurantId, transferStatus, from, to } = {}) => {
  const filter = historyFilter({ restaurantId, from, to });
  if (transferStatus) {
    const statuses = STATUSES_FOR_TRANSFER[transferStatus];
    if (!statuses) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown transferStatus');
    filter.status = { $in: statuses };
  }
  const settlements = await RestaurantSettlement.find(filter).sort({ periodStart: -1, _id: -1 }).limit(10_000).lean();
  const restaurants = await restaurantsById(settlements.map((s) => s.restaurantId));
  return settlements.map((s) => historyRow(s, restaurants));
};

// ── Payout detail (D1–D6) ─────────────────────────────────────────────────────

const RECORD_TYPE_LABELS = {
  dine_in_earning: 'Dine-in bill',
  counter_platform_fee: 'Dine-in dues',
  refund_gateway_fee: 'Refund',
  carry_forward: 'Carried forward',
};

const recordsOf = async (entries, settlement) => {
  const orderIds = entries.filter((e) => e.orderId).map((e) => e.orderId);
  const billIds = entries.filter((e) => e.billId).map((e) => e.billId);
  const [orders, bills] = await Promise.all([
    Order.find({ _id: { $in: orderIds } }).select('type createdAt').lean(),
    Bill.find({ _id: { $in: billIds } }).select('billNumber tableNumber createdAt').lean(),
  ]);
  const om = new Map(orders.map((o) => [String(o._id), o]));
  const bm = new Map(bills.map((b) => [String(b._id), b]));
  return entries.map((e) => {
    const order = e.orderId ? om.get(String(e.orderId)) : null;
    const bill = e.billId ? bm.get(String(e.billId)) : null;
    let type = RECORD_TYPE_LABELS[e.type] ?? 'Record';
    if (e.type === 'order_earning') type = order?.type === 'takeaway' ? 'Takeaway order' : 'Delivery order';
    if (e.type === 'counter_platform_fee' && e.orderId) type = 'Counter order dues';
    if (e.type === 'adjustment') type = e.breakdown?.kind === 'penalty' ? 'Penalty' : 'Adjustment';
    return {
      entryId: e._id,
      kind: e.orderId ? 'order' : e.billId ? 'bill' : 'other',
      orderId: e.orderId ?? null,
      billId: e.billId ?? null,
      displayNo: order ? displayNoOfOrder(order) : bill ? displayNoOfBill(bill) : null,
      type,
      ledgerType: e.type,
      placedAt: order?.createdAt ?? bill?.createdAt ?? null,
      datedAt: e.eligibleAt,
      amountToRestaurantPaise: signed(e),
      status: orderPaymentStatusOf(e, settlement),
      note: e.note ?? '',
    };
  });
};

const progressOf = (s) => {
  const p = s.payout ?? {};
  const failed = s.status === 'failed';
  return [
    { key: 'eligible', label: 'Eligible', done: s.status !== 'on_hold', at: s.clearedAt ?? null },
    { key: 'scheduled', label: 'Scheduled', done: ['approved', 'processing', 'paid', 'failed'].includes(s.status), at: p.scheduledAt ?? null, date: p.scheduledFor ?? null },
    { key: 'released', label: 'Released', done: ['processing', 'paid', 'failed'].includes(s.status), at: p.releasedAt ?? p.initiatedAt ?? null },
    failed
      ? { key: 'failed', label: 'Failed', done: true, at: p.lastFailure?.at ?? p.failedAt ?? null }
      : { key: 'paid', label: 'Paid', done: s.status === 'paid', at: p.creditedAt ?? p.paidAt ?? null },
  ];
};

/** One restaurant's weekly payout for the admin: calculation, records, progress, owner view. */
export const payoutDetail = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid settlement id');
  const settlement = await RestaurantSettlement.findById(id).lean();
  if (!settlement) throw new ApiError(404, 'NOT_FOUND', 'Settlement not found');
  const { timezone } = await settingsZone();
  const [entries, restaurant, tickets] = await Promise.all([
    RestaurantLedgerEntry.find({ settlementId: settlement._id }).sort({ eligibleAt: 1, _id: 1 }).lean(),
    Restaurant.findById(settlement.restaurantId)
      .select('name gstRegistered payoutAccount.status payoutAccount.accountNumberLast4 payoutAccount.verifiedAt payoutAccount.pendingChange.status')
      .lean(),
    SupportTicket.find({ settlementId: settlement._id })
      .select('ticketNumber issueType status subject createdAt')
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  const records = await recordsOf(entries, settlement);
  const pa = restaurant?.payoutAccount ?? {};
  return {
    settlement: {
      _id: settlement._id,
      restaurantId: settlement.restaurantId,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      status: settlement.status,
      totals: settlement.totals,
      entryCount: settlement.entryCount,
      clearedAt: settlement.clearedAt ?? null,
      payout: {
        scheduledFor: settlement.payout?.scheduledFor ?? null,
        attemptRef: settlement.payout?.attemptRef ?? null,
        releasedAt: settlement.payout?.releasedAt ?? null,
        bankReference: settlement.payout?.utr ?? null,
        creditedAt: settlement.payout?.creditedAt ?? null,
        provider: settlement.payout?.provider ?? null,
        batchId: settlement.payout?.batchId ?? null,
        lastFailure: settlement.payout?.lastFailure?.at ? settlement.payout.lastFailure : null,
        history: settlement.payout?.history ?? [],
      },
      hold:
        settlement.status === 'on_hold'
          ? {
              manual: settlement.holdReason === 'MANUAL',
              reason: settlement.holdReason === 'MANUAL' ? settlement.holdCode ?? 'other' : settlement.holdReason,
              label: holdLabelOf(settlement),
              // Staff-only — the admin portal's internal note (never in an owner response).
              internalNote: settlement.holdNote ?? null,
              heldAt: settlement.heldAt ?? null,
            }
          : null,
    },
    restaurant: { _id: settlement.restaurantId, name: restaurant?.name ?? null, gstRegistered: restaurant?.gstRegistered ?? null },
    destination: {
      accountNumberLast4: settlement.payout?.beneficiary?.accountNumberLast4 ?? pa.accountNumberLast4 ?? null,
      verified: pa.status === 'verified',
      changeRequested: ['in_review', 'awaiting_restaurant'].includes(pa.pendingChange?.status),
    },
    eligibility: eligibilityOf(settlement),
    transfer: transferOf(settlement),
    nextAction: nextActionOf(settlement),
    calculation: calculationLines(settlement, entries, { gstRegistered: restaurant?.gstRegistered !== false }),
    counts: {
      foodOrders: entries.filter((e) => e.type === 'order_earning').length,
      dineInBills: entries.filter((e) => e.type === 'dine_in_earning').length,
      dineInAdjustments: entries.filter((e) => e.type === 'counter_platform_fee').length,
      refunds: entries.filter((e) => e.type === 'refund_gateway_fee').length,
    },
    records,
    progress: progressOf(settlement),
    linkedTickets: tickets.map((t) => ({ _id: t._id, ticketNumber: t.ticketNumber ?? null, issueType: t.issueType ?? null, status: t.status, subject: t.subject, createdAt: t.createdAt })),
    ownerView: ownerViewOf(settlement, { timezone }),
    holdReasons: HOLD_REASONS,
  };
};
