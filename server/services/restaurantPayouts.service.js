// Paying restaurants any day, in full or in part — the replacement for the weekly settlement
// statement (config/payoutMode.js). Three things live here:
//
//   • the BALANCE a restaurant is owed right now — from its ledger (models/RestaurantLedgerEntry.js),
//     minus what weekly statements already paid it before the switch;
//   • PAYING it: the super admin records a payment (any amount up to the balance, including money
//     still clearing — Yulo pays that in advance), booked as a `payout` debit on the ledger;
//   • the DAILY REPORT for any day or range: what the restaurant earned each day, what was deducted,
//     what it was paid, and the balance owed at the end of each day.
//
// Balance owed = Σ every ledger row (credits − debits, direct payments included as debits)
//              − Σ weekly statements already paid (or with the transfer already sent).
// "Clearing" is the part of it whose online money Razorpay has not settled to Yulo yet.
// All amounts in PAISE; days are calendar days in India (Asia/Kolkata).

import mongoose from 'mongoose';
import ExcelJS from 'exceljs';

import Restaurant from '../models/Restaurant.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import RestaurantPayment, { PAYMENT_MODES } from '../models/RestaurantPayment.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { payoutAccountView } from './payoutAccount.service.js';
import { logActivity } from './activityLog.service.js';

export const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_REPORT_DAYS = 366;
export const MIN_PAYMENT_PAISE = 100; // ₹1
const LOCK_MS = 2 * 60 * 1000;

// A weekly statement whose money has left Yulo (paid) or is on its way (released to the bank).
const SETTLED_STATUSES = ['paid', 'processing'];
const EARNING_TYPES = ['order_earning', 'dine_in_earning'];
const DEDUCTION_TYPES = ['counter_platform_fee', 'refund_gateway_fee'];
// Modes that move money to the restaurant's bank account — only to a verified one.
const BANK_MODES = ['neft', 'imps', 'rtgs'];

const signed = { $cond: [{ $eq: ['$direction', 'credit'] }, '$amountPaise', { $multiply: ['$amountPaise', -1] }] };
const toId = (id) => new mongoose.Types.ObjectId(String(id));

// ── Days ─────────────────────────────────────────────────────────────────────────────────────

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const istDay = (d) => dayFmt.format(new Date(d));

const istStart = (ymd, field) => {
  if (!DATE_ONLY.test(String(ymd ?? ''))) throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a date like 2026-11-25`);
  const [y, m, d] = ymd.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is not a real date`);
  }
  return new Date(`${ymd}T00:00:00${IST_OFFSET}`);
};

/** IST days [from, to] → { from, to, start, end } (end exclusive). `to` defaults to `from`. */
export const parseRange = ({ from, to }, { maxDays = MAX_REPORT_DAYS } = {}) => {
  const f = String(from ?? '').trim() || istDay(new Date());
  const t = String(to ?? '').trim() || f;
  const start = istStart(f, 'from');
  const end = new Date(istStart(t, 'to').getTime() + DAY_MS);
  if (end <= start) throw new ApiError(400, 'VALIDATION_ERROR', '"to" must be on or after "from"');
  if ((end - start) / DAY_MS > maxDays) throw new ApiError(400, 'RANGE_TOO_LONG', `Choose a range of ${maxDays} days or fewer`);
  return { from: f, to: t, start, end };
};

const daysOf = ({ start, end }) => {
  const out = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) out.push(istDay(new Date(t)));
  return out;
};

// ── Balances ─────────────────────────────────────────────────────────────────────────────────

/**
 * Balance owed to each restaurant — a Map of restaurantId → { balancePaise, clearingPaise,
 * clearedPaise }. `restaurantIds` omitted = every restaurant with a ledger.
 */
export const balancesOf = async (restaurantIds = null, now = new Date()) => {
  const scope = restaurantIds ? { restaurantId: { $in: restaurantIds.map(toId) } } : {};
  const [ledger, settled] = await Promise.all([
    RestaurantLedgerEntry.aggregate([
      { $match: scope },
      {
        $group: {
          _id: '$restaurantId',
          total: { $sum: signed },
          // Online money Razorpay has not settled to Yulo yet (never inside a paid statement).
          clearing: { $sum: { $cond: [{ $gt: ['$clearsAt', now] }, signed, 0] } },
        },
      },
    ]),
    RestaurantSettlement.aggregate([
      { $match: { ...scope, status: { $in: SETTLED_STATUSES } } },
      { $group: { _id: '$restaurantId', paid: { $sum: '$totals.netPayable' } } },
    ]),
  ]);
  const paidBy = new Map(settled.map((s) => [String(s._id), s.paid ?? 0]));
  const out = new Map();
  for (const row of ledger) {
    const balance = (row.total ?? 0) - (paidBy.get(String(row._id)) ?? 0);
    const clearing = Math.max(0, Math.min(row.clearing ?? 0, balance));
    out.set(String(row._id), { balancePaise: balance, clearingPaise: clearing, clearedPaise: balance - clearing });
  }
  return out;
};

const zeroBalance = { balancePaise: 0, clearingPaise: 0, clearedPaise: 0 };

export const balanceOf = async (restaurantId, now = new Date()) =>
  (await balancesOf([restaurantId], now)).get(String(restaurantId)) ?? { ...zeroBalance };

const accountOf = (restaurant) => {
  const a = payoutAccountView(restaurant);
  return {
    status: a.status,
    holderName: a.accountHolderName,
    accountNumberLast4: a.accountNumberLast4,
    accountNumberMasked: a.accountNumberMasked,
    ifsc: a.ifsc,
    bankName: a.bankName,
    hasPendingChange: a.hasPendingChange,
  };
};

const lastPayments = async (restaurantIds) => {
  const rows = await RestaurantPayment.aggregate([
    { $match: { restaurantId: { $in: restaurantIds.map(toId) } } },
    { $sort: { paidAt: -1, _id: -1 } },
    { $group: { _id: '$restaurantId', paidAt: { $first: '$paidAt' }, amountPaise: { $first: '$amountPaise' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { paidAt: r.paidAt, amountPaise: r.amountPaise }]));
};

/**
 * The super admin's list: every restaurant with money on its ledger (or a search match), what it
 * is owed now and how much of that has cleared, its payout account and its last payment.
 * `due`: only restaurants owed something. Sorted by balance owed, largest first.
 */
export const listBalances = async ({ q, due = false, page = 1, limit = 25 } = {}) => {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const balances = await balancesOf();
  const term = String(q ?? '').trim();
  const filter = term
    ? { name: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    : { _id: { $in: [...balances.keys()].map(toId) } };
  const restaurants = await Restaurant.find(filter).select('name approvalStatus payoutAccount').limit(5000).lean();

  let rows = restaurants.map((r) => ({
    restaurantId: r._id,
    name: r.name,
    approvalStatus: r.approvalStatus,
    ...(balances.get(String(r._id)) ?? zeroBalance),
    account: accountOf(r),
  }));
  if (due) rows = rows.filter((r) => r.balancePaise > 0);
  rows.sort((a, b) => b.balancePaise - a.balancePaise || a.name.localeCompare(b.name));

  const totals = rows.reduce(
    (t, r) => ({
      balancePaise: t.balancePaise + Math.max(0, r.balancePaise),
      clearingPaise: t.clearingPaise + r.clearingPaise,
      clearedPaise: t.clearedPaise + Math.max(0, r.clearedPaise),
      restaurantsDue: t.restaurantsDue + (r.balancePaise > 0 ? 1 : 0),
    }),
    { balancePaise: 0, clearingPaise: 0, clearedPaise: 0, restaurantsDue: 0 }
  );
  const pageRows = rows.slice((p - 1) * l, p * l);
  const last = await lastPayments(pageRows.map((r) => r.restaurantId));
  return {
    rows: pageRows.map((r) => ({ ...r, lastPayment: last.get(String(r.restaurantId)) ?? null })),
    totals,
    total: rows.length,
    page: p,
    pages: Math.ceil(rows.length / l),
  };
};

/** One restaurant for the "Pay" dialog: balance, payout account, last few payments. */
export const restaurantBalance = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select('name payoutAccount').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const [balance, recent] = await Promise.all([
    balanceOf(restaurantId),
    RestaurantPayment.find({ restaurantId }).sort({ paidAt: -1, _id: -1 }).limit(5).lean(),
  ]);
  return { restaurantId: restaurant._id, name: restaurant.name, ...balance, account: accountOf(restaurant), recentPayments: recent.map(adminPaymentView) };
};

// ── Paying ───────────────────────────────────────────────────────────────────────────────────

const locks = () => mongoose.connection.collection('restaurant_payout_locks');

// One payment per restaurant at a time: two admins (or a double-click) can't both pay the same
// balance. A lock left behind by a crashed request expires after LOCK_MS.
const withLock = async (restaurantId, fn) => {
  const _id = String(restaurantId);
  const now = new Date();
  try {
    await locks().insertOne({ _id, at: now });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const stale = await locks().deleteOne({ _id, at: { $lt: new Date(now.getTime() - LOCK_MS) } });
    if (!stale.deletedCount) throw new ApiError(409, 'PAYMENT_IN_PROGRESS', 'Another payment to this restaurant is being recorded — refresh in a moment');
    await locks().insertOne({ _id, at: now });
  }
  try {
    return await fn();
  } finally {
    await locks().deleteOne({ _id, at: now }).catch(() => {});
  }
};

const formatNumber = (seq) => `RP-${String(seq).padStart(6, '0')}`;

/**
 * Records a payment to a restaurant. `full: true` pays the whole balance owed; otherwise
 * `amountPaise` (₹1 up to the balance). `expectedBalancePaise` — the balance the admin was
 * shown — refuses the payment (409 BALANCE_CHANGED) if it moved meanwhile.
 */
export const payRestaurant = async (restaurantId, input, adminId) => {
  const { full = false, amountPaise, mode, reference, paidOn, note = '', expectedBalancePaise } = input ?? {};
  if (!PAYMENT_MODES.includes(mode)) throw new ApiError(400, 'VALIDATION_ERROR', 'Choose how the money was sent');
  const ref = String(reference ?? '').trim();
  if (ref.length < 3 || ref.length > 60) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter the UTR / payment reference');
  const today = istDay(new Date());
  const paidDay = paidOn ? String(paidOn).trim() : today;
  const paidStart = istStart(paidDay, 'paidOn');
  if (paidDay > today) throw new ApiError(400, 'VALIDATION_ERROR', 'The payment date cannot be in the future');
  // Today: the actual time; an earlier day: noon that day, so it sorts inside the right day.
  const paidAt = paidDay === today ? new Date() : new Date(paidStart.getTime() + 12 * 60 * 60 * 1000);

  const restaurant = await Restaurant.findById(restaurantId).select('name payoutAccount').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const account = accountOf(restaurant);
  if (BANK_MODES.includes(mode) && account.status !== 'verified') {
    throw new ApiError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', "This restaurant's bank account isn't verified yet — verify it before paying by bank transfer");
  }

  return withLock(restaurantId, async () => {
    const balance = await balanceOf(restaurantId);
    if (expectedBalancePaise != null && Number(expectedBalancePaise) !== balance.balancePaise) {
      throw new ApiError(409, 'BALANCE_CHANGED', 'The balance changed since you opened this — check the new amount and pay again');
    }
    if (balance.balancePaise < MIN_PAYMENT_PAISE) throw new ApiError(409, 'NOTHING_DUE', 'Nothing is owed to this restaurant right now');

    const amount = full ? balance.balancePaise : Number(amountPaise);
    if (!Number.isInteger(amount) || amount < MIN_PAYMENT_PAISE) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter an amount of at least ₹1');
    if (amount > balance.balancePaise) {
      throw new ApiError(400, 'AMOUNT_TOO_HIGH', `You can pay at most ₹${(balance.balancePaise / 100).toFixed(2)} — the balance owed`);
    }

    const payment = await RestaurantPayment.create({
      restaurantId,
      paymentNumber: formatNumber(await nextSequence('restaurant_payment')),
      amountPaise: amount,
      kind: amount === balance.balancePaise ? 'full' : 'partial',
      mode,
      reference: ref,
      paidAt,
      note: String(note ?? '').trim().slice(0, 300),
      balanceBeforePaise: balance.balancePaise,
      clearedBeforePaise: balance.clearedPaise,
      beneficiary: {
        holderName: account.holderName,
        accountNumberLast4: account.accountNumberLast4,
        ifsc: account.ifsc,
        bankName: account.bankName,
      },
      createdBy: adminId,
    });
    try {
      await RestaurantLedgerEntry.create({
        restaurantId,
        type: 'payout',
        direction: 'debit',
        amountPaise: amount,
        paymentId: payment._id,
        eligibleAt: paidAt,
        clearsAt: null,
        createdBy: adminId,
        note: `Paid ${payment.paymentNumber} · ${mode.toUpperCase()} ${ref}`,
      });
    } catch (err) {
      // Without its ledger row the payment would not lower the balance — undo it.
      await RestaurantPayment.deleteOne({ _id: payment._id }).catch(() => {});
      throw err;
    }

    await logActivity({
      adminId,
      action: 'restaurant.payment',
      targetType: 'Restaurant',
      targetId: restaurantId,
      metadata: { paymentId: payment._id, paymentNumber: payment.paymentNumber, amountPaise: amount, kind: payment.kind, mode, reference: ref },
    }).catch(() => {});

    return { payment: adminPaymentView(payment.toObject()), balance: await balanceOf(restaurantId) };
  });
};

// ── Payments list ────────────────────────────────────────────────────────────────────────────

const MODE_LABEL = { neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', upi: 'UPI', cash: 'Cash', cheque: 'Cheque', other: 'Other' };

export const adminPaymentView = (p) => ({
  _id: p._id,
  restaurantId: p.restaurantId,
  paymentNumber: p.paymentNumber,
  amountPaise: p.amountPaise,
  kind: p.kind,
  mode: p.mode,
  modeLabel: MODE_LABEL[p.mode] ?? p.mode,
  reference: p.reference,
  paidAt: p.paidAt,
  note: p.note ?? '',
  balanceBeforePaise: p.balanceBeforePaise,
  clearedBeforePaise: p.clearedBeforePaise,
  beneficiary: p.beneficiary ?? null,
  createdAt: p.createdAt,
});

// What the restaurant sees: no internal note, no who-recorded-it.
export const ownerPaymentView = (p) => {
  const { note: _note, clearedBeforePaise: _c, ...rest } = adminPaymentView(p);
  return rest;
};

export const listPayments = async ({ restaurantId, from, to, page = 1, limit = 25, view = adminPaymentView } = {}) => {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const filter = {};
  if (restaurantId) filter.restaurantId = toId(restaurantId);
  if (from || to) {
    const range = parseRange({ from, to });
    filter.paidAt = { $gte: range.start, $lt: range.end };
  }
  const [rows, agg] = await Promise.all([
    RestaurantPayment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
    RestaurantPayment.aggregate([{ $match: filter }, { $group: { _id: null, count: { $sum: 1 }, amountPaise: { $sum: '$amountPaise' } } }]),
  ]);
  const names = restaurantId
    ? new Map()
    : new Map(
        (await Restaurant.find({ _id: { $in: [...new Set(rows.map((r) => String(r.restaurantId)))] } }).select('name').lean()).map((r) => [String(r._id), r.name])
      );
  const total = agg[0]?.count ?? 0;
  return {
    payments: rows.map((r) => ({ ...view(r), ...(restaurantId ? {} : { restaurantName: names.get(String(r.restaurantId)) ?? null }) })),
    totals: { count: total, amountPaise: agg[0]?.amountPaise ?? 0 },
    page: p,
    pages: Math.ceil(total / l),
  };
};

// ── Daily report ─────────────────────────────────────────────────────────────────────────────

const zeroDay = () => ({ entries: 0, earningsPaise: 0, deductionsPaise: 0, adjustmentsPaise: 0, netEarnedPaise: 0, paidPaise: 0, payments: 0 });

// A weekly statement counts as paid on the day it was paid (or released to the bank, while in flight).
const settledAt = { $ifNull: ['$payout.paidAt', { $ifNull: ['$payout.releasedAt', '$updatedAt'] }] };

/**
 * Day by day for [from, to] (IST): earnings (orders and dine-in bills), deductions (counter
 * platform fees, refund fees), adjustments, net earned, paid out, and the balance owed at the
 * end of each day. `restaurantId` omitted = all restaurants together, with a per-restaurant
 * summary of the range.
 */
export const dailyReport = async ({ restaurantId, from, to }) => {
  const range = parseRange({ from, to });
  const scope = restaurantId ? { restaurantId: toId(restaurantId) } : {};
  const day = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TIMEZONE } });
  // Earnings, deductions and adjustments count on the day they were recorded; payments on the day paid.
  const eventDate = { $cond: [{ $eq: ['$type', 'payout'] }, '$eligibleAt', '$createdAt'] };

  const [ledgerDays, ledgerBefore, settledDays, settledBefore, perRestaurant] = await Promise.all([
    RestaurantLedgerEntry.aggregate([
      { $match: scope },
      { $addFields: { at: eventDate } },
      { $match: { at: { $gte: range.start, $lt: range.end } } },
      {
        $group: {
          _id: day('$at'),
          entries: { $sum: { $cond: [{ $in: ['$type', EARNING_TYPES] }, 1, 0] } },
          earnings: { $sum: { $cond: [{ $in: ['$type', EARNING_TYPES] }, signed, 0] } },
          deductions: { $sum: { $cond: [{ $in: ['$type', DEDUCTION_TYPES] }, '$amountPaise', 0] } },
          adjustments: { $sum: { $cond: [{ $in: ['$type', ['adjustment', 'carry_forward']] }, signed, 0] } },
          paid: { $sum: { $cond: [{ $eq: ['$type', 'payout'] }, '$amountPaise', 0] } },
          payments: { $sum: { $cond: [{ $eq: ['$type', 'payout'] }, 1, 0] } },
        },
      },
    ]),
    RestaurantLedgerEntry.aggregate([
      { $match: scope },
      { $addFields: { at: eventDate } },
      { $match: { at: { $lt: range.start } } },
      { $group: { _id: null, total: { $sum: signed } } },
    ]),
    RestaurantSettlement.aggregate([
      { $match: { ...scope, status: { $in: SETTLED_STATUSES } } },
      { $addFields: { at: settledAt } },
      { $match: { at: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: day('$at'), paid: { $sum: '$totals.netPayable' }, payments: { $sum: 1 } } },
    ]),
    RestaurantSettlement.aggregate([
      { $match: { ...scope, status: { $in: SETTLED_STATUSES } } },
      { $addFields: { at: settledAt } },
      { $match: { at: { $lt: range.start } } },
      { $group: { _id: null, paid: { $sum: '$totals.netPayable' } } },
    ]),
    restaurantId
      ? null
      : RestaurantLedgerEntry.aggregate([
          { $addFields: { at: eventDate } },
          { $match: { at: { $gte: range.start, $lt: range.end } } },
          {
            $group: {
              _id: '$restaurantId',
              earned: { $sum: { $cond: [{ $eq: ['$type', 'payout'] }, 0, signed] } },
              paid: { $sum: { $cond: [{ $eq: ['$type', 'payout'] }, '$amountPaise', 0] } },
            },
          },
        ]),
  ]);

  const byDay = new Map(daysOf(range).map((d) => [d, zeroDay()]));
  for (const r of ledgerDays) {
    const d = byDay.get(r._id);
    if (!d) continue;
    d.entries += r.entries;
    d.earningsPaise += r.earnings;
    d.deductionsPaise += r.deductions;
    d.adjustmentsPaise += r.adjustments;
    d.paidPaise += r.paid;
    d.payments += r.payments;
  }
  for (const r of settledDays) {
    const d = byDay.get(r._id);
    if (!d) continue;
    d.paidPaise += r.paid ?? 0;
    d.payments += r.payments;
  }

  // Balance owed at the start of the range: everything recorded before it (payments included,
  // as debits) minus weekly statements paid before it.
  const opening = (ledgerBefore[0]?.total ?? 0) - (settledBefore[0]?.paid ?? 0);
  let balance = opening;
  const days = [];
  const totals = { ...zeroDay() };
  for (const [date, d] of byDay) {
    d.netEarnedPaise = d.earningsPaise - d.deductionsPaise + d.adjustmentsPaise;
    // Ledger payouts are already debits inside "paid"; the day's change in balance is net earned − paid.
    balance += d.netEarnedPaise - d.paidPaise;
    days.push({ date, ...d, closingBalancePaise: balance });
    for (const k of Object.keys(totals)) totals[k] += d[k];
  }

  let restaurants = null;
  if (perRestaurant) {
    const ids = [...new Set([...perRestaurant.map((r) => String(r._id))])];
    const [docs, balances] = await Promise.all([
      Restaurant.find({ _id: { $in: ids } }).select('name').lean(),
      balancesOf(ids),
    ]);
    const name = new Map(docs.map((d) => [String(d._id), d.name]));
    const settledInRange = await RestaurantSettlement.aggregate([
      { $match: { _id: { $exists: true }, status: { $in: SETTLED_STATUSES } } },
      { $addFields: { at: settledAt } },
      { $match: { at: { $gte: range.start, $lt: range.end } } },
      { $group: { _id: '$restaurantId', paid: { $sum: '$totals.netPayable' } } },
    ]);
    const weeklyPaid = new Map(settledInRange.map((s) => [String(s._id), s.paid]));
    restaurants = perRestaurant
      .map((r) => ({
        restaurantId: r._id,
        name: name.get(String(r._id)) ?? null,
        netEarnedPaise: r.earned,
        paidPaise: r.paid + (weeklyPaid.get(String(r._id)) ?? 0),
        balanceNowPaise: balances.get(String(r._id))?.balancePaise ?? 0,
      }))
      .sort((a, b) => b.netEarnedPaise - a.netEarnedPaise);
  }

  return {
    from: range.from,
    to: range.to,
    openingBalancePaise: opening,
    closingBalancePaise: balance,
    totals,
    days: days.reverse(), // newest first, as the screens read it
    restaurants,
  };
};

// ── Excel ────────────────────────────────────────────────────────────────────────────────────

const MONEY = '#,##0.00;[Red]-#,##0.00';
const rs = (p) => Math.round(p ?? 0) / 100;
const displayDay = (ymd) => ymd.split('-').reverse().join('-');
const header = (sheet) => {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4572E' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};
const dateTime = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

/** The daily report (and the payments in the range) as an Excel workbook. */
export const dailyReportWorkbook = async ({ restaurantId, from, to, owner = false }) => {
  const report = await dailyReport({ restaurantId, from, to });
  const payments = await listPayments({ restaurantId, from: report.from, to: report.to, limit: 100, view: owner ? ownerPaymentView : adminPaymentView });
  const all = [...payments.payments];
  for (let page = 2; page <= payments.pages; page += 1) {
    all.push(...(await listPayments({ restaurantId, from: report.from, to: report.to, page, limit: 100, view: owner ? ownerPaymentView : adminPaymentView })).payments);
  }
  const restaurant = restaurantId ? await Restaurant.findById(restaurantId).select('name').lean() : null;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yulo Stores';

  const daily = wb.addWorksheet('Daily');
  daily.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Orders & bills', key: 'entries', width: 13 },
    { header: 'Earnings (₹)', key: 'earnings', width: 14 },
    { header: 'Deductions (₹)', key: 'deductions', width: 14 },
    { header: 'Adjustments (₹)', key: 'adjustments', width: 15 },
    { header: 'Net earned (₹)', key: 'net', width: 14 },
    { header: 'Paid (₹)', key: 'paid', width: 13 },
    { header: 'Balance owed at day end (₹)', key: 'closing', width: 24 },
  ];
  for (const d of [...report.days].reverse()) {
    daily.addRow({
      date: displayDay(d.date),
      entries: d.entries,
      earnings: rs(d.earningsPaise),
      deductions: rs(d.deductionsPaise),
      adjustments: rs(d.adjustmentsPaise),
      net: rs(d.netEarnedPaise),
      paid: rs(d.paidPaise),
      closing: rs(d.closingBalancePaise),
    });
  }
  const t = report.totals;
  const totalRow = daily.addRow({
    date: 'Total',
    entries: t.entries,
    earnings: rs(t.earningsPaise),
    deductions: rs(t.deductionsPaise),
    adjustments: rs(t.adjustmentsPaise),
    net: rs(t.netEarnedPaise),
    paid: rs(t.paidPaise),
    closing: rs(report.closingBalancePaise),
  });
  totalRow.font = { bold: true };
  for (const k of ['earnings', 'deductions', 'adjustments', 'net', 'paid', 'closing']) daily.getColumn(k).numFmt = MONEY;
  header(daily);
  daily.addRow([]);
  daily.addRow([`Balance owed at the start: ₹${rs(report.openingBalancePaise).toFixed(2)}. Dates are in India time (IST).`]).font = { italic: true };

  const pay = wb.addWorksheet('Payments');
  pay.columns = [
    { header: 'Paid on', key: 'paidAt', width: 20 },
    { header: 'Payment no.', key: 'number', width: 12 },
    ...(restaurantId ? [] : [{ header: 'Restaurant', key: 'restaurant', width: 26 }]),
    { header: 'Amount (₹)', key: 'amount', width: 13 },
    { header: 'Full / part', key: 'kind', width: 10 },
    { header: 'Mode', key: 'mode', width: 9 },
    { header: 'UTR / reference', key: 'reference', width: 24 },
    { header: 'To account', key: 'account', width: 22 },
    ...(owner ? [] : [{ header: 'Note', key: 'note', width: 30 }]),
  ];
  for (const p of all) {
    pay.addRow({
      paidAt: dateTime.format(new Date(p.paidAt)),
      number: p.paymentNumber,
      restaurant: p.restaurantName ?? '',
      amount: rs(p.amountPaise),
      kind: p.kind === 'full' ? 'Full' : 'Part',
      mode: p.modeLabel,
      reference: p.reference,
      account: p.beneficiary?.accountNumberLast4 ? `${p.beneficiary.bankName ?? 'Bank'} ••${p.beneficiary.accountNumberLast4}` : '',
      note: p.note ?? '',
    });
  }
  pay.getColumn('amount').numFmt = MONEY;
  header(pay);

  if (report.restaurants) {
    const sheet = wb.addWorksheet('Restaurants');
    sheet.columns = [
      { header: 'Restaurant', key: 'name', width: 28 },
      { header: 'Net earned in range (₹)', key: 'net', width: 20 },
      { header: 'Paid in range (₹)', key: 'paid', width: 16 },
      { header: 'Balance owed now (₹)', key: 'balance', width: 18 },
    ];
    for (const r of report.restaurants) sheet.addRow({ name: r.name ?? '', net: rs(r.netEarnedPaise), paid: rs(r.paidPaise), balance: rs(r.balanceNowPaise) });
    for (const k of ['net', 'paid', 'balance']) sheet.getColumn(k).numFmt = MONEY;
    header(sheet);
  }

  const slug = String(restaurant?.name ?? 'all-restaurants').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'restaurant';
  const span = report.from === report.to ? report.from : `${report.from}-to-${report.to}`;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `payouts-${slug}-${span}.xlsx` };
};

/** The restaurant's own Payments summary: balance, clearing, paid this month and the last payment. */
export const ownerSummary = async (restaurantId) => {
  const today = istDay(new Date());
  const monthStart = new Date(`${today.slice(0, 8)}01T00:00:00${IST_OFFSET}`);
  const [balance, last, month] = await Promise.all([
    balanceOf(restaurantId),
    RestaurantPayment.findOne({ restaurantId }).sort({ paidAt: -1, _id: -1 }).lean(),
    RestaurantPayment.aggregate([
      { $match: { restaurantId: toId(restaurantId), paidAt: { $gte: monthStart } } },
      { $group: { _id: null, amountPaise: { $sum: '$amountPaise' }, count: { $sum: 1 } } },
    ]),
  ]);
  return {
    ...balance,
    paidThisMonthPaise: month[0]?.amountPaise ?? 0,
    paymentsThisMonth: month[0]?.count ?? 0,
    lastPayment: last ? ownerPaymentView(last) : null,
  };
};
