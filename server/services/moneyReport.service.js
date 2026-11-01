import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import Restaurant from '../models/Restaurant.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import Payout from '../models/Payout.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise } from '../utils/money.js';
import { weekBounds } from '../utils/week.js';
import { transferOf } from '../utils/payoutStatus.js';
import { getActiveSettings } from './financeSettings.service.js';
import { computeRestaurantSettlementLine } from './settlementMath.service.js';
import { ensurePayoutForPeriod } from './payout.service.js';
import * as settlementService from './settlement.service.js';

// The super admin's money view (Orders & Money, Weekly Report): for every order and dine-in bill,
// what the customer paid, what reached Yulo, what the restaurant gets (or owes), what the rider
// gets and what Yulo keeps — and, per week, what Yulo owes each restaurant and each rider and
// whether it has been paid. Read-mostly; paying goes through settlement.service.js (restaurants)
// and payout.service.js (riders), so the restaurant portal and the rider app see the same status.
//
// Figures are FINAL once the money is booked (the restaurant's ledger rows, the rider's frozen
// earnings on a delivered order) and PROJECTED before that (an order not delivered yet, a bill
// still open) — each row says which. All amounts in paise.

const MAX_ROWS = 5000;
const signed = (e) => (e.direction === 'credit' ? e.amountPaise : -e.amountPaise);
const shortRef = (id) => `#${String(id).slice(-6).toUpperCase()}`;

const channelOf = (doc) =>
  doc.paymentChannel ?? (doc.paymentMethod === 'online' || doc.paidBy === 'online' ? 'online' : doc.paymentMethod === 'cash' ? 'cod' : 'counter');

// Rider base + distance (+ surge − penalty) + tip, from the breakdown frozen on the order.
const riderPayOf = (order) => {
  const e = order.deliveryAssignment?.earningsBreakdown;
  if (!e?.computedAt) return 0;
  return toPaise((e.basePay ?? 0) + (e.distancePay ?? 0) + (e.surgePay ?? 0) - (e.penalty ?? 0) + (e.tip ?? 0));
};

const restaurantPayoutState = (entries, settlementsById, now) => {
  if (!entries.length) return { state: 'not_due', label: 'Not due yet' };
  const inStatement = entries.find((e) => e.settlementId);
  if (inStatement) {
    const s = settlementsById.get(String(inStatement.settlementId));
    const t = s ? transferOf(s) : null;
    if (t?.status === 'paid') return { state: 'paid', label: 'Paid', settlementId: s._id, paidAt: t.paidAt, reference: t.bankReference };
    return { state: 'in_statement', label: s ? `In statement · ${t.label}` : 'In statement', settlementId: inStatement.settlementId };
  }
  const clearsAt = entries.map((e) => new Date(e.clearsAt ?? e.eligibleAt)).sort((a, b) => b - a)[0];
  if (clearsAt > now) return { state: 'clearing', label: 'Clearing', clearsAt };
  return { state: 'ready', label: 'Cleared · next statement' };
};

const riderPayoutState = (order, payoutsByKey, cycle) => {
  if (order.type !== 'delivery' || !order.deliveryAssignment?.partnerId) return null;
  if (order.deliveryAssignment.status !== 'delivered' || !order.deliveredAt) return { state: 'not_due', label: 'Not delivered yet' };
  const week = weekBounds(order.deliveredAt, cycle).start.toISOString();
  const p = payoutsByKey.get(`${order.deliveryAssignment.partnerId}|${week}`);
  if (p?.status === 'paid') return { state: 'paid', label: 'Paid', paidAt: p.paidAt, reference: p.paymentReference ?? null, payoutId: p._id };
  return { state: 'pending', label: 'Pending · weekly payout', payoutId: p?._id ?? null };
};

/**
 * Every delivery/takeaway order and dine-in bill placed in [from, to], newest first, with its
 * money split, plus totals over the whole filter. `type`: 'delivery' | 'takeaway' | 'dine_in'.
 */
export const moneyRows = async ({ from, to, type, restaurantId, page = 1, limit = 50, all = false, now = new Date() } = {}) => {
  const settings = await getActiveSettings();
  const cycle = settings.settlementCycle;
  const range = { $gte: new Date(from), $lte: new Date(to) };
  const rid = restaurantId ? new mongoose.Types.ObjectId(String(restaurantId)) : null;

  const wantOrders = !type || type === 'delivery' || type === 'takeaway';
  const wantBills = !type || type === 'dine_in';

  const [orders, bills] = await Promise.all([
    wantOrders
      ? Order.find({
          ...(rid ? { restaurantId: rid } : {}),
          type: type && type !== 'dine_in' ? type : { $in: ['delivery', 'takeaway'] },
          createdAt: range,
          // Checkouts nobody paid for are not money — an online order that never got paid.
          $nor: [{ paymentChannel: 'online', paymentStatus: { $in: ['pending', 'failed'] } }],
        })
          .select('restaurantId type status paymentStatus paymentChannel paymentMethod charges grandTotal createdAt deliveredAt cancelledAt refund deliveryAssignment.partnerId deliveryAssignment.status deliveryAssignment.earningsBreakdown +razorpayFee')
          .sort({ createdAt: -1 })
          .limit(MAX_ROWS)
          .lean()
      : [],
    wantBills
      ? Bill.find({ ...(rid ? { restaurantId: rid } : {}), type: 'dine_in', createdAt: range, status: { $ne: 'cancelled' } })
          .select('restaurantId billNumber tableNumber status paymentChannel paidBy charges grandTotal createdAt paidAt +razorpayFee')
          .sort({ createdAt: -1 })
          .limit(MAX_ROWS)
          .lean()
      : [],
  ]);

  const orderIds = orders.map((o) => o._id);
  const billIds = bills.map((b) => b._id);
  const entries = await RestaurantLedgerEntry.find({ $or: [{ orderId: { $in: orderIds } }, { billId: { $in: billIds } }] })
    .select('orderId billId type direction amountPaise settlementId clearsAt eligibleAt')
    .lean();
  const entriesOf = new Map();
  for (const e of entries) {
    const k = String(e.orderId ?? e.billId);
    if (!entriesOf.has(k)) entriesOf.set(k, []);
    entriesOf.get(k).push(e);
  }
  const settlementIds = [...new Set(entries.filter((e) => e.settlementId).map((e) => String(e.settlementId)))];
  const settlements = await RestaurantSettlement.find({ _id: { $in: settlementIds } }).select('status payout totals').lean();
  const settlementsById = new Map(settlements.map((s) => [String(s._id), s]));

  const partnerIds = [...new Set(orders.map((o) => o.deliveryAssignment?.partnerId).filter(Boolean).map(String))];
  const [payouts, partners, restaurants] = await Promise.all([
    partnerIds.length
      ? Payout.find({ partnerId: { $in: partnerIds }, periodType: 'weekly' }).select('partnerId periodStart status paidAt paymentReference').lean()
      : [],
    DeliveryPartner.find({ _id: { $in: partnerIds } }).select('fullName').lean(),
    Restaurant.find({ _id: { $in: [...new Set([...orders, ...bills].map((d) => String(d.restaurantId)))] } }).select('name').lean(),
  ]);
  const payoutsByKey = new Map(payouts.map((p) => [`${p.partnerId}|${new Date(p.periodStart).toISOString()}`, p]));
  const partnerName = new Map(partners.map((p) => [String(p._id), p.fullName ?? null]));
  const restaurantName = new Map(restaurants.map((r) => [String(r._id), r.name]));

  const rows = [];
  for (const o of orders) {
    const channel = channelOf(o);
    const paid = o.paymentStatus === 'paid' || o.paymentStatus === 'refunded';
    const customerPaid = o.charges?.grandTotal ?? toPaise(o.grandTotal ?? 0);
    const refunded = o.refund?.status === 'processed' || o.paymentStatus === 'refunded' ? o.refund?.amountPaise ?? customerPaid : 0;
    const yuloReceived = channel === 'online' && paid ? customerPaid - refunded : 0;
    const own = entriesOf.get(String(o._id)) ?? [];
    let restaurantShare;
    let final = true;
    if (own.length) restaurantShare = own.reduce((n, e) => n + signed(e), 0);
    else if (o.status === 'cancelled') restaurantShare = 0;
    else {
      final = false;
      restaurantShare = o.charges
        ? computeRestaurantSettlementLine({ charges: o.charges, paymentChannel: channel === 'online' ? 'online' : 'counter', settings }).restaurantNet
        : 0;
    }
    const riderPay = o.status === 'cancelled' ? 0 : riderPayOf(o);
    if (o.type === 'delivery' && o.deliveryAssignment?.status !== 'delivered' && o.status !== 'cancelled') final = false;
    const gatewayFee = channel === 'online' && paid ? o.razorpayFee ?? 0 : 0;
    const partnerId = o.deliveryAssignment?.partnerId ? String(o.deliveryAssignment.partnerId) : null;
    rows.push({
      kind: 'order',
      id: o._id,
      ref: shortRef(o._id),
      type: o.type,
      restaurant: { _id: o.restaurantId, name: restaurantName.get(String(o.restaurantId)) ?? null },
      placedAt: o.createdAt,
      status: o.status,
      paymentChannel: channel,
      paymentStatus: o.paymentStatus,
      customerPaidPaise: customerPaid,
      refundedPaise: refunded,
      yuloReceivedPaise: yuloReceived,
      restaurantSharePaise: restaurantShare,
      riderPayPaise: riderPay,
      gatewayFeePaise: gatewayFee,
      yuloKeepsPaise: yuloReceived - restaurantShare - riderPay - gatewayFee,
      final,
      rider: partnerId ? { _id: partnerId, name: partnerName.get(partnerId) ?? null } : null,
      restaurantPayout: o.status === 'cancelled' && !own.length ? { state: 'none', label: '—' } : restaurantPayoutState(own, settlementsById, now),
      riderPayout: riderPayoutState(o, payoutsByKey, cycle),
    });
  }
  for (const b of bills) {
    const channel = b.status === 'paid' ? (b.paymentChannel ?? (b.paidBy === 'online' ? 'online' : 'counter')) : null;
    const customerPaid = b.charges?.grandTotal ?? toPaise(b.grandTotal ?? 0);
    const yuloReceived = channel === 'online' ? customerPaid : 0;
    const own = entriesOf.get(String(b._id)) ?? [];
    let restaurantShare;
    let final = true;
    if (own.length) restaurantShare = own.reduce((n, e) => n + signed(e), 0);
    else if (b.status === 'paid') restaurantShare = 0; // paid, nothing owed either way
    else {
      final = false;
      // Still open: shown as if paid online (the larger figure); the channel decides it at payment.
      restaurantShare = b.charges ? computeRestaurantSettlementLine({ charges: b.charges, paymentChannel: 'online', settings }).restaurantNet : 0;
    }
    const gatewayFee = channel === 'online' ? b.razorpayFee ?? 0 : 0;
    rows.push({
      kind: 'bill',
      id: b._id,
      ref: b.billNumber ?? shortRef(b._id),
      type: 'dine_in',
      tableNumber: b.tableNumber ?? null,
      restaurant: { _id: b.restaurantId, name: restaurantName.get(String(b.restaurantId)) ?? null },
      placedAt: b.createdAt,
      status: b.status,
      paymentChannel: channel,
      paymentStatus: b.status === 'paid' ? 'paid' : 'pending',
      customerPaidPaise: customerPaid,
      refundedPaise: 0,
      yuloReceivedPaise: yuloReceived,
      restaurantSharePaise: restaurantShare,
      riderPayPaise: 0,
      gatewayFeePaise: gatewayFee,
      yuloKeepsPaise: yuloReceived - restaurantShare - gatewayFee,
      final,
      rider: null,
      restaurantPayout: b.status === 'paid' ? restaurantPayoutState(own, settlementsById, now) : { state: 'not_due', label: 'Bill open' },
      riderPayout: null,
    });
  }
  rows.sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));

  const sum = (key, list = rows) => list.reduce((n, r) => n + (r[key] ?? 0), 0);
  const completed = rows.filter((r) => r.final);
  const totals = {
    count: rows.length,
    // Net of refunds: an order refunded in full no longer counts as money customers paid.
    customerPaidPaise: sum('customerPaidPaise') - sum('refundedPaise'),
    yuloReceivedPaise: sum('yuloReceivedPaise'),
    refundedPaise: sum('refundedPaise'),
    // Booked money only (delivered orders, paid bills) — what is actually owed.
    restaurantsPaise: sum('restaurantSharePaise', completed),
    ridersPaise: sum('riderPayPaise', completed),
    gatewayFeesPaise: sum('gatewayFeePaise', completed),
    yuloKeepsPaise: sum('yuloKeepsPaise', completed),
    // Orders still in progress: projected, not yet owed.
    inProgress: { count: rows.length - completed.length, restaurantsPaise: sum('restaurantSharePaise', rows.filter((r) => !r.final)) },
    truncated: orders.length >= MAX_ROWS || bills.length >= MAX_ROWS,
  };
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  return { from: new Date(from), to: new Date(to), totals, rows: all ? rows : rows.slice((p - 1) * l, p * l), page: p, limit: l, total: rows.length };
};

/**
 * The Payouts page's Live tab: the week's orders and bills per restaurant AS THEY HAPPEN — before
 * any weekly statement exists. For each restaurant: what customers paid, what the restaurant has
 * earned so far (booked) and what orders still in progress would add, and where that money is on
 * its way to a payout — clearing (2 working days after payment), cleared (joins the next
 * statement), in a statement, or paid. Plus the latest orders across all restaurants.
 */
export const liveWeek = async ({ weekStart, now = new Date() } = {}) => {
  const { settlementCycle } = await getActiveSettings();
  const { start, end } = weekBounds(weekStart ? new Date(weekStart) : now, settlementCycle);
  const data = await moneyRows({ from: start, to: end, all: true, now });

  const byRestaurant = new Map();
  for (const r of data.rows) {
    const key = String(r.restaurant?._id);
    if (!byRestaurant.has(key)) {
      byRestaurant.set(key, {
        restaurant: r.restaurant,
        orders: 0,
        inProgress: 0,
        customerPaidPaise: 0,
        yuloReceivedPaise: 0,
        earnedPaise: 0,
        projectedPaise: 0,
        ridersPaise: 0,
        clearingPaise: 0,
        readyPaise: 0,
        inStatementPaise: 0,
        paidPaise: 0,
        lastOrderAt: null,
      });
    }
    const g = byRestaurant.get(key);
    g.orders += 1;
    g.customerPaidPaise += (r.customerPaidPaise ?? 0) - (r.refundedPaise ?? 0);
    g.yuloReceivedPaise += r.yuloReceivedPaise ?? 0;
    if (!g.lastOrderAt || new Date(r.placedAt) > new Date(g.lastOrderAt)) g.lastOrderAt = r.placedAt;
    if (!r.final) {
      g.inProgress += 1;
      g.projectedPaise += r.restaurantSharePaise ?? 0;
      continue;
    }
    g.earnedPaise += r.restaurantSharePaise ?? 0;
    g.ridersPaise += r.riderPayPaise ?? 0;
    const state = r.restaurantPayout?.state;
    if (state === 'clearing') g.clearingPaise += r.restaurantSharePaise ?? 0;
    else if (state === 'ready') g.readyPaise += r.restaurantSharePaise ?? 0;
    else if (state === 'in_statement') g.inStatementPaise += r.restaurantSharePaise ?? 0;
    else if (state === 'paid') g.paidPaise += r.restaurantSharePaise ?? 0;
  }
  const restaurants = [...byRestaurant.values()].sort((a, b) => b.earnedPaise + b.projectedPaise - (a.earnedPaise + a.projectedPaise));
  const sum = (key) => restaurants.reduce((n, g) => n + g[key], 0);
  return {
    periodStart: start,
    periodEnd: end,
    weekEnded: end.getTime() < now.getTime(),
    generatedAt: now,
    totals: {
      orders: data.rows.length,
      inProgress: sum('inProgress'),
      customerPaidPaise: sum('customerPaidPaise'),
      yuloReceivedPaise: sum('yuloReceivedPaise'),
      earnedPaise: sum('earnedPaise'),
      projectedPaise: sum('projectedPaise'),
      ridersPaise: sum('ridersPaise'),
      clearingPaise: sum('clearingPaise'),
      readyPaise: sum('readyPaise'),
      inStatementPaise: sum('inStatementPaise'),
      paidPaise: sum('paidPaise'),
      yuloKeepsPaise: data.totals.yuloKeepsPaise,
    },
    restaurants,
    latest: data.rows.slice(0, 15),
  };
};

const maskedAccount = (bank) => {
  if (!bank) return null;
  if (bank.upiId) return { kind: 'upi', label: bank.upiId };
  if (bank.accountNumber) return { kind: 'bank', label: `A/c ••${String(bank.accountNumber).slice(-4)}${bank.ifscCode ? ` · ${bank.ifscCode}` : ''}` };
  return null;
};

// Unsettled, cleared restaurant rows up to the week's end that generating this week would actually
// take — not those of a restaurant whose statement for the week is already locked (scheduled, paid…):
// they wait for the next week.
const waitingRecords = async (start, end) => {
  const rows = await RestaurantLedgerEntry.find({ settlementId: null, eligibleAt: { $lte: end } }).select('restaurantId').lean();
  if (!rows.length) return 0;
  const locked = new Set(
    (await RestaurantSettlement.find({ periodStart: start, status: { $nin: ['draft', 'on_hold'] } }).select('restaurantId').lean()).map((x) =>
      String(x.restaurantId)
    )
  );
  return rows.filter((r) => !locked.has(String(r.restaurantId))).length;
};

/**
 * One week's payouts: every restaurant's statement and every rider's weekly payout, with what is
 * owed and what has been paid — the page the admin clears the week from. Plus the money that came
 * in from orders placed that week.
 */
export const weeklyReport = async ({ weekStart, now = new Date() } = {}) => {
  const settings = await getActiveSettings();
  const cycle = settings.settlementCycle;
  const at = weekStart ? new Date(weekStart) : settlementService.previousWeekStart(now, cycle);
  const { start, end } = weekBounds(at, cycle);
  const weekEnded = end.getTime() < now.getTime();

  // Riders: every rider who delivered that week, or already has a row for it.
  const delivering = await Order.distinct('deliveryAssignment.partnerId', {
    type: 'delivery',
    'deliveryAssignment.status': 'delivered',
    deliveredAt: { $gte: start, $lte: end },
  });
  const withRows = await Payout.distinct('partnerId', { periodType: 'weekly', periodStart: start });
  const riderIds = [...new Set([...delivering, ...withRows].filter(Boolean).map(String))];
  await Promise.all(riderIds.map((id) => ensurePayoutForPeriod(id, 'weekly', start)));

  const [settlements, payouts, money, waitingForStatement] = await Promise.all([
    RestaurantSettlement.find({ periodStart: start }).sort({ 'totals.netPayable': -1 }).lean(),
    Payout.find({ periodType: 'weekly', periodStart: start, partnerId: { $in: riderIds } }).sort({ netPayable: -1 }).lean(),
    moneyRows({ from: start, to: end, limit: 1, now }),
    // Cleared restaurant money up to this week's end that no statement holds yet — what
    // "Generate statements" would pick up (the Monday 03:00 run does it on its own).
    waitingRecords(start, end),
  ]);
  const [restaurants, partners] = await Promise.all([
    Restaurant.find({ _id: { $in: settlements.map((s) => s.restaurantId) } }).select('name payoutAccount.status payoutAccount.accountNumberLast4 payoutAccount.ifsc').lean(),
    DeliveryPartner.find({ _id: { $in: riderIds } }).select('fullName phone bankDetails').lean(),
  ]);
  const rMap = new Map(restaurants.map((r) => [String(r._id), r]));
  const pMap = new Map(partners.map((p) => [String(p._id), p]));

  const restaurantRows = settlements.map((s) => {
    const r = rMap.get(String(s.restaurantId));
    const t = transferOf(s);
    return {
      settlementId: s._id,
      restaurant: { _id: s.restaurantId, name: r?.name ?? null },
      orders: s.entryCount ?? 0,
      netPayablePaise: s.totals?.netPayable ?? 0,
      // What the week left the restaurant owing Yulo (counter dues, refund fees beyond its
      // earnings) — moved to next week's statement, so netPayable shows 0.
      carriedForwardPaise: s.totals?.carryForwardOut ?? 0,
      status: s.status,
      transfer: { status: t.status, label: t.label, paidAt: t.paidAt, reference: t.bankReference },
      holdReason: s.holdReason ?? null,
      account: {
        verified: r?.payoutAccount?.status === 'verified',
        label: r?.payoutAccount?.accountNumberLast4 ? `A/c ••${r.payoutAccount.accountNumberLast4}${r.payoutAccount.ifsc ? ` · ${r.payoutAccount.ifsc}` : ''}` : null,
      },
      // What the admin can do from the report.
      canMarkPaid: ['draft', 'approved', 'processing'].includes(s.status) && (s.totals?.netPayable ?? 0) > 0 && weekEnded,
    };
  });
  // Riders with nothing for the week (no deliveries, ₹0) are left out: the old "Clear Pending
  // Payments" marked every rider's row paid, ₹0 ones included, which read as "10 paid · ₹0".
  const riderRows = payouts.filter((p) => (p.deliveriesCount ?? 0) > 0 || Math.abs(p.netPayable ?? 0) > 0).map((p) => {
    const partner = pMap.get(String(p.partnerId));
    return {
      payoutId: p._id,
      rider: { _id: p.partnerId, name: partner?.fullName ?? null, phone: partner?.phone ?? null },
      deliveries: p.deliveriesCount ?? 0,
      basePayPaise: toPaise(p.basePay ?? 0),
      distancePayPaise: toPaise(p.distancePay ?? 0),
      tipsPaise: toPaise(p.tips ?? 0),
      incentivesPaise: toPaise(p.incentives ?? 0),
      deductionsPaise: toPaise(p.deductions ?? 0),
      netPayablePaise: toPaise(p.netPayable ?? 0),
      status: p.status,
      paidAt: p.status === 'paid' ? p.paidAt ?? null : null,
      reference: p.status === 'paid' ? p.paymentReference ?? null : null,
      account: maskedAccount(partner?.bankDetails),
      canMarkPaid: p.status === 'pending' && (p.netPayable ?? 0) > 0 && weekEnded,
    };
  });

  const sum = (list, key) => list.reduce((n, r) => n + (r[key] ?? 0), 0);
  const restaurantsPaid = restaurantRows.filter((r) => r.transfer.status === 'paid' && r.netPayablePaise > 0);
  // A week whose counter dues / refund fees outweigh its earnings: nothing to pay — the balance is
  // owed to Yulo and carried into the next statement.
  const restaurantsOwing = restaurantRows.filter((r) => r.netPayablePaise < 0 || r.holdReason === 'NEGATIVE_BALANCE_CARRIED_FORWARD');
  const restaurantsOwed = restaurantRows.filter((r) => r.transfer.status !== 'paid' && r.netPayablePaise > 0 && r.status !== 'carried_forward');
  const ridersPaid = riderRows.filter((r) => r.status === 'paid' && r.netPayablePaise > 0);
  const ridersOwed = riderRows.filter((r) => r.status !== 'paid' && r.netPayablePaise > 0);

  return {
    periodStart: start,
    periodEnd: end,
    weekEnded,
    statementsGenerated: settlements.length > 0,
    recordsWaitingForStatement: weekEnded ? waitingForStatement : 0,
    moneyIn: money.totals,
    summary: {
      restaurants: {
        owedPaise: sum(restaurantsOwed, 'netPayablePaise'),
        owedCount: restaurantsOwed.length,
        paidPaise: sum(restaurantsPaid, 'netPayablePaise'),
        paidCount: restaurantsPaid.length,
        owesYuloPaise: restaurantsOwing.reduce((n, r) => n + r.carriedForwardPaise + Math.max(0, -r.netPayablePaise), 0),
        owesYuloCount: restaurantsOwing.length,
        statements: restaurantRows.length,
      },
      riders: {
        owedPaise: sum(ridersOwed, 'netPayablePaise'),
        owedCount: ridersOwed.length,
        paidPaise: sum(ridersPaid, 'netPayablePaise'),
        paidCount: ridersPaid.length,
      },
    },
    restaurants: restaurantRows,
    riders: riderRows,
  };
};

/**
 * "Mark paid" for a restaurant from the weekly report: the admin has already sent the money by
 * net banking and enters its reference. Walks the statement through the same lifecycle steps the
 * Payouts page uses — schedule (today) → release → paid — so every check still applies (week
 * ended, verified account, amount unchanged) and the restaurant portal shows "Paid · <ref>".
 */
export const payRestaurantFromReport = async (settlementId, { reference, paidOn, expectedNetPaise }, adminId) => {
  if (!mongoose.isValidObjectId(settlementId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid settlement id');
  const ref = String(reference ?? '').trim();
  if (ref.length < 4) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter the bank reference (UTR) of the transfer');
  if (await RestaurantSettlement.exists({ _id: { $ne: settlementId }, 'payout.utr': ref })) {
    throw new ApiError(409, 'DUPLICATE_REFERENCE', 'That bank reference is already recorded for another payout');
  }
  let s = await RestaurantSettlement.findById(settlementId).lean();
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Statement not found');
  if (expectedNetPaise != null && expectedNetPaise !== s.totals?.netPayable) {
    throw new ApiError(409, 'AMOUNT_CHANGED', 'The amount changed — refresh and check it again');
  }
  if (s.status === 'draft') {
    s = (await settlementService.scheduleSettlement(settlementId, { scheduledFor: new Date() }, adminId)).toObject();
  }
  if (s.status === 'approved') {
    s = (await settlementService.releaseSettlement(settlementId, adminId, { expectedNetPaise: s.totals.netPayable })).toObject();
  }
  if (s.status !== 'processing') {
    throw new ApiError(409, 'NOT_PAYABLE', `This statement can't be marked paid (it is ${s.status})`);
  }
  return settlementService.recordPayoutPaid(settlementId, { bankReference: ref, creditedAt: paidOn }, adminId);
};

