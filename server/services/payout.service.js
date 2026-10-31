import mongoose from 'mongoose';
import Payout from '../models/Payout.js';
import Order from '../models/Order.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { ApiError } from '../utils/ApiError.js';
import { getActiveSettings } from './financeSettings.service.js';
import { toRupees } from '../utils/money.js';
import { dayBounds, monthBounds, weekBounds } from '../utils/week.js';
import logger from '../utils/logger.js';

// Rider payouts. What a rider is owed for a period is the sum of the earnings frozen on each
// order they delivered (Order.deliveryAssignment.earningsBreakdown — base pay, distance pay and
// the customer's tip, worked out when they accepted it; see deliveryAssignment.service.js's
// computeRiderEarningsBreakdown). Payout rows are computed on read and upserted; there is no
// separate scheduler.
//
// Rules:
//   - Only WEEKLY payouts are paid. A monthly row covers the same deliveries as its weeks — it is
//     a statement; paying it too would pay the rider twice.
//   - A paid (or processing) payout is frozen: never recomputed, never adjusted.
//   - A week is paid only after it has ended, so a delivery can't land in a week that was
//     already paid out.
//   - Periods are drawn in the settlement time zone (IST), not the server's clock.
//   - Rows keyed on any other period start ("legacy" — e.g. the UTC Mondays the code used before
//     B10, or an old settlement cycle) are never paid. Deliveries a PAID legacy row already
//     covered are left out of the current row for the same dates, so nothing is paid twice;
//     scripts/migratePayoutPeriods.js clears out the pending ones.

const PAYABLE_PERIOD = 'weekly';
const FROZEN = ['paid', 'processing'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const periodIn = (periodType, at, cycle) => {
  if (periodType === 'today') return dayBounds(at, cycle);
  if (periodType === 'monthly') return monthBounds(at, cycle);
  return weekBounds(at, cycle);
};

/** The period containing `at` for 'today' | 'weekly' | 'monthly'. Kept for earnings.service.js. */
export const getPeriod = async (periodType = 'weekly', at = new Date()) => {
  const { settlementCycle } = await getActiveSettings();
  return periodIn(periodType, at, settlementCycle);
};

/** Is this row keyed on a period start the current cycle would draw? (false = legacy row) */
export const isCanonicalPeriod = (row, cycle) =>
  periodIn(row.periodType, row.periodStart, cycle).start.getTime() === new Date(row.periodStart).getTime();

// Other rows of the same partner and period type whose dates overlap [start, end] — only legacy
// rows can (current-cycle periods never overlap each other).
const overlappingRows = (partnerId, periodType, { start, end }) =>
  Payout.find({ partnerId, periodType, periodStart: { $ne: start, $lte: end }, periodEnd: { $gte: start } }).lean();

// Backward-compatible name used across the codebase (now async, IST-based).
export const getCurrentPeriod = (periodType = 'weekly') => getPeriod(periodType, new Date());

// Shared by Financial Analytics (server/services/finance.service.js) and the delivery partner
// payout endpoints, so the two can never disagree on the platform's rider spend for a period.
// Weekly rows only — monthly rows restate the same deliveries and would double count them.
// `excludeTips`: what riders cost Yulo itself — customers' tips are their money, passed through.
export const getPlatformPayoutTotal = async ({ from, to, excludeTips = false }) => {
  const [result] = await Payout.aggregate([
    { $match: { periodType: PAYABLE_PERIOD, periodStart: { $gte: from }, periodEnd: { $lte: to } } },
    {
      $group: {
        _id: null,
        total: { $sum: excludeTips ? { $subtract: ['$netPayable', { $ifNull: ['$tips', 0] }] } : '$netPayable' },
      },
    },
  ]);
  return round2(result?.total ?? 0);
};

/** Customers' tips paid on to riders in weekly payouts over [from, to] (pass-through money). */
export const getPlatformRiderTips = async ({ from, to }) => {
  const [result] = await Payout.aggregate([
    { $match: { periodType: PAYABLE_PERIOD, periodStart: { $gte: from }, periodEnd: { $lte: to } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$tips', 0] } } } },
  ]);
  return round2(result?.total ?? 0);
};

// Sum of the frozen per-delivery earnings for a rider's deliveries in [start, end], leaving out
// any delivered in an `excluded` range (dates a paid legacy row already paid for).
const earningsIn = async (partnerId, { start, end }, excluded = []) => {
  const [agg] = await Order.aggregate([
    {
      $match: {
        'deliveryAssignment.partnerId': new mongoose.Types.ObjectId(String(partnerId)),
        type: 'delivery',
        'deliveryAssignment.status': 'delivered',
        deliveredAt: { $gte: start, $lte: end },
        ...(excluded.length
          ? { $nor: excluded.map((r) => ({ deliveredAt: { $gte: r.periodStart, $lte: r.periodEnd } })) }
          : {}),
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        basePay: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.basePay', 0] } },
        distancePay: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.distancePay', 0] } },
        surgePay: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.surgePay', 0] } },
        tips: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.tip', 0] } },
        penalty: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.penalty', 0] } },
      },
    },
  ]);
  return {
    count: agg?.count ?? 0,
    basePay: round2(agg?.basePay),
    distancePay: round2(agg?.distancePay),
    tips: round2(agg?.tips),
    gross: round2((agg?.basePay ?? 0) + (agg?.distancePay ?? 0) + (agg?.surgePay ?? 0) - (agg?.penalty ?? 0)),
  };
};

/**
 * Creates or refreshes the payout row for the period containing `at`. A paid or processing row
 * is returned exactly as it is. Admin-entered incentives/deductions are kept.
 */
export const ensurePayoutForPeriod = async (partnerId, periodType = PAYABLE_PERIOD, at = new Date()) => {
  const { start, end } = await getPeriod(periodType, at);
  const existing = await Payout.findOne({ partnerId, periodType, periodStart: start });
  if (existing && FROZEN.includes(existing.status)) return existing;

  // Legacy rows over the same dates: a paid one's deliveries are not paid again here; a pending
  // one with nothing an admin entered is superseded by this row and removed (one with incentives
  // or deductions is left for scripts/migratePayoutPeriods.js to carry them over).
  const overlaps = await overlappingRows(partnerId, periodType, { start, end });
  const paidElsewhere = overlaps.filter((r) => FROZEN.includes(r.status));
  const superseded = overlaps.filter((r) => !FROZEN.includes(r.status) && !r.incentives && !r.deductions);
  if (superseded.length) {
    await Payout.deleteMany({ _id: { $in: superseded.map((r) => r._id) }, status: 'pending', incentives: { $in: [0, null] }, deductions: { $in: [0, null] } });
  }

  const earned = await earningsIn(partnerId, { start, end }, paidElsewhere);
  const incentives = existing?.incentives ?? 0;
  const deductions = existing?.deductions ?? 0;
  const values = {
    periodEnd: end,
    deliveriesCount: earned.count,
    perDeliveryRate: toRupees((await getActiveSettings()).riderBasePay),
    basePay: earned.basePay,
    distancePay: earned.distancePay,
    tips: earned.tips,
    grossEarnings: earned.gross,
    netPayable: round2(earned.gross + earned.tips + incentives - deductions),
    computedAt: new Date(),
  };

  return Payout.findOneAndUpdate(
    // The status condition makes a concurrent "mark paid" win: once paid, this upsert matches
    // nothing and the duplicate-key insert it would attempt is caught below.
    { partnerId, periodType, periodStart: start, status: { $nin: FROZEN } },
    {
      $set: values,
      $setOnInsert: { incentives: 0, deductions: 0, status: 'pending' },
    },
    { upsert: true, new: true }
  ).catch(async (err) => {
    if (err?.code !== 11000) throw err;
    // Lost to a concurrent "mark paid" (or another upsert): that row now exists.
    const row = await Payout.findOne({ partnerId, periodType, periodStart: start });
    if (row) return row;
    // The collision was with ANOTHER period type starting the same day — the pre-B10 unique index
    // on { partnerId, periodStart } is still in place. Report it and return the figures unsaved
    // rather than failing every payout screen; nothing can be paid from an unsaved row.
    logger.error(
      { partnerId, periodType, periodStart: start, index: err?.keyPattern ?? null },
      'Rider payout row not saved: old unique index on payouts — run scripts/fixPayoutPeriodIndex.js'
    );
    return new Payout({ partnerId, periodType, periodStart: start, incentives: 0, deductions: 0, status: 'pending', ...values });
  });
};

// The current period and the one before it — so last week's row is finalised once the week is
// over even if nobody opened the payouts page during it.
const ensureRecent = async (partnerId, periodType) => {
  const now = new Date();
  const { start } = await getPeriod(periodType, now);
  await ensurePayoutForPeriod(partnerId, periodType, new Date(start.getTime() - 1));
  return ensurePayoutForPeriod(partnerId, periodType, now);
};

const withPayable = (row, cycle, now = Date.now()) => {
  const legacy = !isCanonicalPeriod(row, cycle);
  return {
    ...row,
    legacy,
    payable:
      row.periodType === PAYABLE_PERIOD && row.status === 'pending' && !legacy && new Date(row.periodEnd).getTime() < now,
  };
};

export const listPayoutsForPartner = async (partnerId, { periodType = PAYABLE_PERIOD, page = 1, limit = 10 } = {}) => {
  await ensureRecent(partnerId, periodType);

  const filter = { partnerId, periodType };
  const skip = (Number(page) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    Payout.find(filter).sort({ periodStart: -1 }).skip(skip).limit(Number(limit)).lean(),
    Payout.countDocuments(filter),
  ]);

  const { settlementCycle } = await getActiveSettings();
  return {
    rows: rows.map((r) => withPayable(r, settlementCycle)),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  };
};

export const adjustPayout = async (payoutId, { incentives, deductions, notes, adjustedBy }) => {
  if (!mongoose.isValidObjectId(payoutId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payout id');
  const payout = await Payout.findById(payoutId);
  if (!payout) throw new ApiError(404, 'NOT_FOUND', 'Payout not found');
  if (!isCanonicalPeriod(payout, (await getActiveSettings()).settlementCycle)) {
    throw new ApiError(409, 'NOT_PAYABLE', 'Old-format period — run scripts/migratePayoutPeriods.js, then adjust the current row');
  }
  if (payout.periodType !== PAYABLE_PERIOD) {
    throw new ApiError(409, 'NOT_PAYABLE', 'Monthly payouts are statements — adjust the weekly payout instead');
  }
  if (FROZEN.includes(payout.status)) {
    throw new ApiError(409, 'PAYOUT_FROZEN', `This payout is already ${payout.status}`);
  }

  if (incentives !== undefined) payout.incentives = incentives;
  if (deductions !== undefined) payout.deductions = deductions;
  if (notes !== undefined) payout.notes = notes;
  const netPayable = round2(payout.grossEarnings + (payout.tips ?? 0) + payout.incentives - payout.deductions);
  // A rider's week can't go below zero: unlike a restaurant statement there is no carry-forward,
  // so a negative week was simply "paid" as negative and the rest of the deduction was lost
  // (and the platform's rider spend understated by it).
  if (netPayable < 0) {
    const maxDeduction = round2(payout.grossEarnings + (payout.tips ?? 0) + payout.incentives);
    throw new ApiError(
      400,
      'DEDUCTION_EXCEEDS_EARNINGS',
      `Deductions can't be more than this week's earnings — at most ₹${maxDeduction.toFixed(2)}`
    );
  }
  payout.netPayable = netPayable;
  payout.adjustedBy = adjustedBy;

  await payout.save();
  return payout;
};

/**
 * Marks weekly payouts paid — only pending ones whose week has ended. Recomputes each one a final
 * time first, so it is paid on every delivery of its week. Returns { modifiedCount, skipped }.
 */
export const markPayoutsPaid = async (payoutIds) => {
  const now = new Date();
  const { settlementCycle } = await getActiveSettings();
  const payouts = await Payout.find({ _id: { $in: payoutIds } }).lean();
  const skipped = [];
  let modifiedCount = 0;

  for (const p of payouts) {
    if (p.periodType !== PAYABLE_PERIOD) {
      skipped.push({ payoutId: p._id, reason: 'Monthly payouts are statements — pay the weekly payouts' });
      continue;
    }
    if (FROZEN.includes(p.status)) {
      skipped.push({ payoutId: p._id, reason: `Already ${p.status}` });
      continue;
    }
    if (!isCanonicalPeriod(p, settlementCycle)) {
      skipped.push({ payoutId: p._id, reason: 'Old-format period — run scripts/migratePayoutPeriods.js, then pay the current row' });
      continue;
    }
    if (new Date(p.periodEnd).getTime() >= now.getTime()) {
      skipped.push({ payoutId: p._id, reason: 'This week has not ended yet' });
      continue;
    }
    await ensurePayoutForPeriod(p.partnerId, PAYABLE_PERIOD, p.periodStart);
    const res = await Payout.updateOne(
      { _id: p._id, status: 'pending' },
      { $set: { status: 'paid', paidAt: now } }
    );
    modifiedCount += res.modifiedCount;
  }
  const found = new Set(payouts.map((p) => String(p._id)));
  for (const id of payoutIds) {
    if (!found.has(String(id))) skipped.push({ payoutId: id, reason: 'Not found' });
  }
  return { modifiedCount, skipped };
};

// Ensures every partner has a current-period (and previous-period) payout row, then aggregates
// for the PartnersList stat cards (Total Payable / Already Paid / Pending Payments count).
//
// Weekly: the summary is for LAST week — the most recent week that has ended, the one whose
// payouts can be paid ("Clear Pending Payments" sends these rows). The running week keeps
// accruing and isn't payable yet; it is in each rider's own payout list. Monthly rows are
// statements: shown, never counted as pending payments.
export const getPayoutSummary = async (periodType = PAYABLE_PERIOD) => {
  const partners = await DeliveryPartner.find().select('_id').lean();
  await Promise.all(partners.map((p) => ensureRecent(p._id, periodType)));

  const current = await getPeriod(periodType);
  const period = periodType === PAYABLE_PERIOD ? await getPeriod(periodType, new Date(current.start.getTime() - 1)) : current;
  const { settlementCycle } = await getActiveSettings();
  const rows = (await Payout.find({ periodType, periodStart: period.start }).lean()).map((r) => withPayable(r, settlementCycle));

  const payable = rows.filter((r) => r.payable);
  const totalPayable = payable.reduce((sum, r) => sum + r.netPayable, 0);
  const alreadyPaid = rows.filter((r) => r.status === 'paid').length;

  return {
    periodType,
    periodStart: period.start,
    periodEnd: period.end,
    totalPayable: round2(totalPayable),
    partnersEligible: rows.length,
    alreadyPaid,
    pendingPayments: payable.length,
    payouts: rows,
  };
};
