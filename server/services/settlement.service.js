import mongoose from 'mongoose';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Restaurant from '../models/Restaurant.js';
import { ApiError } from '../utils/ApiError.js';
import { dayBounds, weekBounds } from '../utils/week.js';
import { nextSequence } from '../models/Counter.js';
import { localDay } from '../config/settlementExport.config.js';
import { FAILURE_REASONS, HOLD_REASONS, eligibilityOf, holdLabelOf, ownerViewOf, transferOf } from '../utils/payoutStatus.js';
import { ACCOUNT_PATHS, accountFingerprint, beneficiaryProblem, beneficiarySnapshot } from './payoutBatch.service.js';
import logger from '../utils/logger.js';
import { getActiveSettings } from './financeSettings.service.js';
import { logActivity } from './activityLog.service.js';

// The weekly settlement: every unsettled row in a restaurant's ledger up to the end of a week,
// claimed by one RestaurantSettlement and summed into what the restaurant is paid.
//
// Generation is idempotent. A week's settlement is created once per restaurant (unique index);
// re-running the week adds any rows that turned up since and re-totals — but only while the
// settlement is still 'draft' or 'on_hold'. Once approved it is frozen; later rows wait for the
// next week. Rows from an earlier week that were never settled (a late ledger write, a
// backfill) are swept into the week being generated rather than stranded.

const OPEN_STATUSES = ['draft', 'on_hold'];
const DAY_MS = 24 * 60 * 60 * 1000;
// How long one generator may hold a settlement (see generationLock on the model). Re-totalling
// one restaurant's week takes well under a second; this only matters if a process dies mid-way.
const LOCK_MS = 2 * 60 * 1000;
// The largest single admin adjustment (₹10 lakh) — a typo guard; bigger corrections are split.
export const MAX_ADJUSTMENT_PAISE = 100_000_000;

// The business clock for "has this week ended / started?". Swappable in tests only — locks always
// use the real time.
let clock = () => new Date();
export const __setSettlementClockForTests = (fn) => {
  clock = fn ?? (() => new Date());
};

// A settlement no generator is re-totalling right now (or whose generator died).
const lockFree = (now = new Date()) => ({
  $or: [{ 'generationLock.until': null }, { 'generationLock.until': { $lt: now } }],
});
const unlocked = { 'generationLock.token': null, 'generationLock.until': null };

const signed = (entry) => (entry.direction === 'credit' ? entry.amountPaise : -entry.amountPaise);

/**
 * Totals of a set of ledger rows. netPayable is simply credits − debits; the other figures
 * break it down for the statement (Yulo Money, settlement charge, counter fees, refunds…).
 */
export const totalsOf = (entries) => {
  const t = {
    grossCustomerPaid: 0,
    tips: 0,
    yuloMoneyPlatformFee: 0,
    yuloMoneyDelivery: 0,
    restaurantBorneDelivery: 0,
    settlementCharge: { base: 0, gst: 0, total: 0 },
    counterPlatformFees: 0,
    refundGatewayFees: 0,
    adjustments: 0,
    carryForwardIn: 0,
    carryForwardOut: 0,
    failedPayoutsCarriedIn: 0,
    planCharges: 0,
    adCharges: 0,
    penalties: 0,
    netPayable: 0,
  };
  for (const e of entries) {
    t.netPayable += signed(e);
    const b = e.breakdown ?? {};
    switch (e.type) {
      case 'order_earning':
      case 'dine_in_earning':
        t.grossCustomerPaid += b.customerPaid ?? 0;
        t.tips += b.tip ?? 0;
        t.yuloMoneyPlatformFee += b.yuloMoney?.platformFee ?? 0;
        t.yuloMoneyDelivery += b.yuloMoney?.deliveryCharge ?? 0;
        t.restaurantBorneDelivery += b.restaurantBorneDelivery ?? 0;
        t.settlementCharge.base += b.settlementCharge?.base ?? 0;
        t.settlementCharge.gst += b.settlementCharge?.gst ?? 0;
        t.settlementCharge.total += b.settlementCharge?.total ?? 0;
        t.planCharges += b.planCharge ?? 0;
        t.adCharges += b.adCharge ?? 0;
        break;
      case 'counter_platform_fee':
        t.counterPlatformFees += e.amountPaise;
        break;
      case 'refund_gateway_fee':
        t.refundGatewayFees += e.amountPaise;
        break;
      case 'adjustment':
        if (b.kind === 'penalty') t.penalties += e.amountPaise;
        else t.adjustments += signed(e);
        break;
      case 'carry_forward':
        // 'out' rows are credits; a debit 'out' row reverses an earlier carry (see settleRestaurant).
        if (b.role === 'out') t.carryForwardOut += signed(e);
        // An earlier settlement whose payout failed, carried into this one (payoutBatch.service.js).
        else if (b.role === 'failed_payout' || b.reason === 'payout_failed') t.failedPayoutsCarriedIn += signed(e);
        else t.carryForwardIn += signed(e);
        break;
      default:
        break;
    }
  }
  return t;
};

// Draft, or on hold for a reason the data decides (as opposed to an admin's manual hold). Decided
// on the CURRENT net: a week whose shortfall was carried out earlier and which has since received
// enough credits (a late delivery, a backfill) is payable again — its earlier carry-out credit is
// part of that net, and next week keeps the matching debit, so the money still adds up exactly.
const decideStatus = ({ net, carriedForward, accountVerified, carryForwardNegative, manualHold }) => {
  if (manualHold) return { status: 'on_hold', holdReason: 'MANUAL' };
  if (net < 0) return { status: 'on_hold', holdReason: carryForwardNegative ? 'NEGATIVE_BALANCE_CARRIED_FORWARD' : 'NEGATIVE_BALANCE' };
  if (net === 0 && carriedForward) return { status: 'on_hold', holdReason: 'NEGATIVE_BALANCE_CARRIED_FORWARD' };
  if (net > 0 && !accountVerified) return { status: 'on_hold', holdReason: 'PAYOUT_ACCOUNT_NOT_VERIFIED' };
  return { status: 'draft', holdReason: null };
};

const findOrCreateSettlement = async ({ restaurantId, periodStart, periodEnd }) => {
  const existing = await RestaurantSettlement.findOne({ restaurantId, periodStart }).lean();
  if (existing) return existing;
  try {
    return (await RestaurantSettlement.create({ restaurantId, periodStart, periodEnd, generatedAt: new Date() })).toObject();
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return RestaurantSettlement.findOne({ restaurantId, periodStart }).lean();
  }
};

/**
 * Settles one restaurant for one week. Returns the settlement, or null when there was nothing
 * to settle (no rows). An approved/paid settlement, or one another generator is re-totalling
 * right now, is returned as it stands.
 *
 * The whole re-total runs under the settlement's generationLock, and its final write only lands
 * while the settlement is still open and still ours — so two generators can't both carry the same
 * shortfall forward, and an approve/hold can't interleave with a re-total. If the write is
 * refused anyway (the lock expired and someone else moved it on), what this run did is undone.
 */
const settleRestaurant = async ({ restaurantId, periodStart, periodEnd, nextWeekStart, settings }) => {
  const settlement = await findOrCreateSettlement({ restaurantId, periodStart, periodEnd });
  if (!OPEN_STATUSES.includes(settlement.status)) return settlement;

  const token = new mongoose.Types.ObjectId().toString();
  const now = new Date();
  const locked = await RestaurantSettlement.findOneAndUpdate(
    { _id: settlement._id, status: { $in: OPEN_STATUSES }, ...lockFree(now) },
    { $set: { 'generationLock.token': token, 'generationLock.until': new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  ).lean();
  if (!locked) return RestaurantSettlement.findById(settlement._id).lean();

  const claimedIds = [];
  const createdIds = [];
  const release = () => RestaurantSettlement.updateOne({ _id: locked._id, 'generationLock.token': token }, { $set: unlocked });

  // Takes back what this run did, when its result can't be saved. Only while the lock is still
  // this run's: re-taking it (atomically, by token) both proves no other generator adopted these
  // rows into totals it saved — one that took over an expired lock holds a new token — and keeps
  // one from starting until the undo is done. Rows another settlement has since claimed (next
  // week claiming the carry-in row) are left where they are: a carry pair is deleted only when
  // both halves are still free, otherwise its halves are just released, so they still cancel out.
  const undo = async () => {
    const stillOurs = await RestaurantSettlement.findOneAndUpdate(
      { _id: locked._id, 'generationLock.token': token },
      { $set: { 'generationLock.until': new Date(Date.now() + LOCK_MS) } }
    ).lean();
    if (!stillOurs) {
      logger.warn({ settlementId: locked._id }, 'Settlement generation not undone — another run took it over and counted its rows');
      return;
    }
    if (createdIds.length) {
      const created = await RestaurantLedgerEntry.find({ _id: { $in: createdIds } }).select('settlementId').lean();
      const free = created.every((e) => e.settlementId == null || String(e.settlementId) === String(locked._id));
      if (free) await RestaurantLedgerEntry.deleteMany({ _id: { $in: createdIds } });
      else claimedIds.push(...createdIds);
    }
    if (claimedIds.length) {
      await RestaurantLedgerEntry.updateMany({ _id: { $in: claimedIds }, settlementId: locked._id }, { $set: { settlementId: null } });
    }
  };
  // A settlement this run created and never got to fill is removed (still ours, still empty).
  const dropIfEmpty = async () => {
    if (await RestaurantLedgerEntry.exists({ settlementId: locked._id })) return;
    await RestaurantSettlement.deleteOne({
      _id: locked._id,
      entryCount: 0,
      status: { $in: OPEN_STATUSES },
      'generationLock.token': token,
    });
  };

  try {
    // Claim every unsettled row up to the end of the week. Atomic per row (settlementId: null in
    // the filter), so two generators can never put one row in two settlements.
    const candidates = await RestaurantLedgerEntry.find({ restaurantId, settlementId: null, eligibleAt: { $lte: periodEnd } }).distinct('_id');
    if (candidates.length) {
      await RestaurantLedgerEntry.updateMany({ _id: { $in: candidates }, settlementId: null }, { $set: { settlementId: locked._id } });
      claimedIds.push(...(await RestaurantLedgerEntry.find({ _id: { $in: candidates }, settlementId: locked._id }).distinct('_id')));
    }

    let entries = await RestaurantLedgerEntry.find({ settlementId: locked._id }).lean();
    if (entries.length === 0) {
      await RestaurantSettlement.deleteOne({ _id: locked._id, entryCount: 0, 'generationLock.token': token });
      await release();
      return null;
    }

    let totals = totalsOf(entries);
    // How much of this week's shortfall should sit in next week: all of it while the week's own
    // rows are negative (and carrying is on), none once they aren't. Only the difference from
    // what is already carried is written — re-running never carries twice, and a week that turned
    // positive (a late delivery) has its carry reversed instead of paying it now AND debiting it
    // next week.
    //
    // With carrying switched off, a shortfall carried earlier stays carried: only an actual
    // improvement of the week's own rows reverses (part of) it. Reversing it because of the
    // setting would leave the debt here, where nothing collects it, and credit it back next week.
    const ownNet = totals.netPayable - totals.carryForwardOut;
    const shortfall = ownNet < 0 ? -ownNet : 0;
    const shouldCarry = settings.carryForwardNegative ? shortfall : Math.min(totals.carryForwardOut, shortfall);
    const delta = shouldCarry - totals.carryForwardOut;
    if (delta !== 0) {
      // A pair so the money is counted exactly once: carrying moves it from here (credit) to the
      // start of next week (debit); reversing moves it back (debit here, credit next week).
      const carrying = delta > 0;
      const amount = Math.abs(delta);
      const pair = await RestaurantLedgerEntry.create([
        {
          restaurantId,
          type: 'carry_forward',
          direction: carrying ? 'credit' : 'debit',
          amountPaise: amount,
          breakdown: { role: 'out', fromSettlementId: locked._id, ...(carrying ? {} : { reversal: true }) },
          eligibleAt: periodEnd,
          clearsAt: periodEnd,
          settlementId: locked._id,
          note: carrying ? 'Negative balance carried forward to next week' : 'Carry-forward reversed — this week is no longer negative',
        },
        {
          restaurantId,
          type: 'carry_forward',
          direction: carrying ? 'debit' : 'credit',
          amountPaise: amount,
          breakdown: { role: 'in', fromSettlementId: locked._id, ...(carrying ? {} : { reversal: true }) },
          eligibleAt: nextWeekStart,
          clearsAt: nextWeekStart,
          note: carrying ? 'Negative balance brought forward from last week' : 'Carry-forward from last week reversed',
        },
      ]);
      createdIds.push(...pair.map((e) => e._id));
      entries = await RestaurantLedgerEntry.find({ settlementId: locked._id }).lean();
      totals = totalsOf(entries);
    }

    const restaurant = await Restaurant.findById(restaurantId).select('payoutAccount.status').lean();
    const { status, holdReason } = decideStatus({
      net: totals.netPayable,
      carriedForward: totals.carryForwardOut > 0,
      accountVerified: restaurant?.payoutAccount?.status === 'verified',
      carryForwardNegative: settings.carryForwardNegative,
      manualHold: locked.holdReason === 'MANUAL',
    });

    const saved = await RestaurantSettlement.findOneAndUpdate(
      { _id: locked._id, status: { $in: OPEN_STATUSES }, 'generationLock.token': token },
      {
        $set: {
          totals,
          entryCount: entries.length,
          status,
          holdReason,
          // When the last of its money reached Yulo (B12 clearing).
          clearedAt: new Date(Math.max(...entries.map((e) => new Date(e.clearsAt ?? e.eligibleAt).getTime()))),
          generatedAt: new Date(),
          ...unlocked,
        },
      },
      { new: true }
    ).lean();
    if (!saved) {
      logger.warn({ settlementId: locked._id }, 'Settlement changed during generation — this run was undone');
      await undo();
      await release();
      return RestaurantSettlement.findById(locked._id).lean();
    }
    return saved;
  } catch (err) {
    await undo().catch((e) => logger.error({ err: e, settlementId: locked._id }, 'Could not undo a failed settlement generation'));
    await dropIfEmpty().catch(() => {});
    await release().catch(() => {});
    throw err;
  }
};

/**
 * Generates (or tops up) every restaurant's settlement for the week containing `weekStart`
 * (any instant in the week will do). Returns { periodStart, periodEnd, settlements: [...] }.
 *
 * A week that hasn't started yet is refused (it would sweep earlier weeks' rows into a future
 * statement). The current week may be generated as an interim draft — it keeps topping up — but
 * it can't be approved until it has ended. `restaurantIds` limits it to those restaurants.
 */
export const generateWeeklySettlements = async (weekStart, { restaurantIds: only } = {}) => {
  const settings = await getActiveSettings();
  const { start: periodStart, end: periodEnd } = weekBounds(weekStart, settings.settlementCycle);
  if (periodStart.getTime() > clock().getTime()) {
    throw new ApiError(409, 'WEEK_NOT_STARTED', 'That week has not started yet');
  }
  const nextWeekStart = new Date(periodEnd.getTime() + 1);
  const scope = only?.length ? { restaurantId: { $in: only.map((id) => new mongoose.Types.ObjectId(String(id))) } } : {};

  const restaurantIds = await RestaurantLedgerEntry.distinct('restaurantId', {
    ...scope,
    settlementId: null,
    eligibleAt: { $lte: periodEnd },
  });
  // Plus restaurants whose open settlement for this week exists already (re-totals after an
  // adjustment, an account verification, an unhold).
  const openIds = await RestaurantSettlement.distinct('restaurantId', { ...scope, periodStart, status: { $in: OPEN_STATUSES } });
  const ids = [...new Set([...restaurantIds, ...openIds].map(String))];

  const settlements = [];
  for (const restaurantId of ids) {
    try {
      const s = await settleRestaurant({
        restaurantId: new mongoose.Types.ObjectId(restaurantId),
        periodStart,
        periodEnd,
        nextWeekStart,
        settings,
      });
      if (s) settlements.push(s);
    } catch (err) {
      logger.error({ err, restaurantId }, 'Settlement generation failed for restaurant');
    }
  }
  return { periodStart, periodEnd, settlements };
};

// ── Admin actions: the B12 payout lifecycle ──────────────────────────────────
//
//   draft ──schedule──▶ approved (scheduled for a date) ──release──▶ processing
//                         │  ▲ change date                              │
//                         │  └───────────── reschedule ──── failed ◀────┤ mark as failed
//                         ▼                                              ▼
//                      on_hold (place on hold / release hold)          paid (mark as paid)
//
// Every step is a conditional write (the status it starts from is in the filter), audit-logged.
// Nothing turns paid on its own: a person records the bank reference.

const loadSettlement = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid settlement id');
  const settlement = await RestaurantSettlement.findById(id);
  if (!settlement) throw new ApiError(404, 'NOT_FOUND', 'Settlement not found');
  return settlement;
};

const regenerate = (settlement) =>
  generateWeeklySettlements(settlement.periodStart, { restaurantIds: [settlement.restaurantId] });

// Why a conditional update matched nothing: the settlement is being re-totalled right now, or
// it moved on (its status no longer allows the action).
const refusal = async (id, notAllowed) => {
  const current = await RestaurantSettlement.findById(id).lean();
  if (!current) return new ApiError(404, 'NOT_FOUND', 'Settlement not found');
  const until = current.generationLock?.until;
  if (until && new Date(until).getTime() >= Date.now()) {
    return new ApiError(409, 'SETTLEMENT_BUSY', 'This settlement is being re-calculated — try again in a moment');
  }
  return notAllowed(current) ?? new ApiError(409, 'CONCURRENT_UPDATE', 'The settlement changed — please refresh');
};

const zoneOf = async () => (await getActiveSettings()).settlementCycle?.timezone ?? 'Asia/Kolkata';

/**
 * A release date as stored: local midnight of that calendar day in the settlement zone. Must be
 * today or later.
 */
const releaseDay = async (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid release date is required');
  const timezone = await zoneOf();
  // A bare "2026-10-12" means that day in the settlement zone, not UTC midnight (05:30 IST).
  const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? dayBounds(new Date(`${value}T12:00:00Z`), { timezone }).start
    : dayBounds(date, { timezone }).start;
  const today = dayBounds(clock(), { timezone }).start;
  if (day.getTime() < today.getTime()) throw new ApiError(400, 'VALIDATION_ERROR', 'The release date cannot be in the past');
  return day;
};

const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const weekdayFmt = new Map();
const localDow = (d, timezone) => {
  let f = weekdayFmt.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
    weekdayFmt.set(timezone, f);
  }
  return DAY_INDEX[f.format(d).toLowerCase()];
};

/** The next payout day (Finance Settings payoutDayOfWeek) on or after today — the date picker's default. */
export const defaultReleaseDay = async () => {
  const settings = await getActiveSettings();
  const timezone = settings.settlementCycle?.timezone ?? 'Asia/Kolkata';
  const target = DAY_INDEX[settings.payoutDayOfWeek] ?? DAY_INDEX.wednesday;
  let day = dayBounds(clock(), { timezone }).start;
  for (let i = 0; i < 7 && localDow(day, timezone) !== target; i += 1) {
    day = dayBounds(new Date(day.getTime() + 30 * 60 * 60 * 1000), { timezone }).start;
  }
  return day;
};

// The restaurant's bank account now, with the encrypted number (for the fingerprint only).
const currentAccount = async (restaurantId) =>
  (await Restaurant.findById(restaurantId).select(ACCOUNT_PATHS).lean())?.payoutAccount ?? null;

const assertSchedulable = async (settlement) => {
  // Weekly settlement: rows of this week may still arrive until it is over.
  if (new Date(settlement.periodEnd).getTime() >= clock().getTime()) {
    throw new ApiError(409, 'WEEK_NOT_ENDED', 'This week has not ended yet — schedule it once it is over');
  }
  if (settlement.totals.netPayable <= 0) throw new ApiError(409, 'NOTHING_TO_PAY', 'This settlement has nothing to pay');
  const pa = await currentAccount(settlement.restaurantId);
  if (pa?.status !== 'verified') {
    throw new ApiError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', "The restaurant's bank account is not verified");
  }
  return pa;
};

/**
 * Schedules an eligible settlement (draft) for a release date — the approval step (B12). The
 * restaurant then sees "Scheduled · <date>". Snapshots the verified account the payment is for:
 * releasing to any other account is refused.
 */
export const scheduleSettlement = async (id, { scheduledFor }, adminId, { action = 'settlement.schedule' } = {}) => {
  const settlement = await loadSettlement(id);
  if (settlement.status !== 'draft') {
    throw new ApiError(
      409,
      'NOT_APPROVABLE',
      settlement.status === 'on_hold'
        ? 'This payout is on hold — release the hold first'
        : `Only an eligible, unscheduled payout can be scheduled (this one is ${settlement.status})`
    );
  }
  const pa = await assertSchedulable(settlement);
  const day = scheduledFor ? await releaseDay(scheduledFor) : await defaultReleaseDay();
  const now = new Date();
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'draft', 'totals.netPayable': { $gt: 0 }, ...lockFree() },
    {
      $set: {
        status: 'approved',
        approvedBy: adminId,
        approvedAt: now,
        'payout.scheduledFor': day,
        'payout.scheduledAt': now,
        'payout.scheduledBy': adminId,
        'payout.beneficiary': beneficiarySnapshot(pa),
      },
    },
    { new: true }
  );
  if (!updated) throw await refusal(id, () => null);
  await logActivity({
    adminId,
    action,
    targetType: 'settlement',
    targetId: updated._id,
    metadata: { netPayable: updated.totals.netPayable, scheduledFor: day },
  });
  return updated;
};

/**
 * Pre-B12 "approve": now the same as scheduling. Without a date it takes the next payout day
 * (Finance Settings payoutDayOfWeek) — kept so existing callers and the bank-file path work.
 */
export const approveSettlement = (id, adminId, { scheduledFor } = {}) =>
  scheduleSettlement(id, { scheduledFor }, adminId, { action: 'settlement.approve' });

/**
 * Change date: a scheduled payout gets a new release date. Scheduling again also re-confirms the
 * destination — the restaurant's verified account now (the M1 screen shows it), so a payout whose
 * account was replaced by a verified change is released to the new one only after this step.
 */
export const changeScheduledDate = async (id, { scheduledFor }, adminId) => {
  const settlement = await loadSettlement(id);
  const day = await releaseDay(scheduledFor);
  const pa = await currentAccount(settlement.restaurantId);
  if (pa?.status !== 'verified') {
    throw new ApiError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', "The restaurant's bank account is not verified");
  }
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'approved' },
    {
      $set: {
        'payout.scheduledFor': day,
        'payout.scheduledAt': new Date(),
        'payout.scheduledBy': adminId,
        'payout.beneficiary': beneficiarySnapshot(pa),
      },
    },
    { new: true }
  );
  if (!updated) {
    throw await refusal(id, (s) =>
      s.status === 'approved' ? null : new ApiError(409, 'NOT_SCHEDULED', `Only a scheduled payout's date can be changed (this one is ${s.status})`)
    );
  }
  await logActivity({ adminId, action: 'settlement.change_date', targetType: 'settlement', targetId: updated._id, metadata: { scheduledFor: day } });
  return updated;
};

/** Reschedule a failed payout: a new release date; the failure stays recorded (lastFailure). */
export const rescheduleSettlement = async (id, { scheduledFor }, adminId) => {
  const settlement = await loadSettlement(id);
  if (settlement.status !== 'failed') {
    throw new ApiError(409, 'NOT_RETRYABLE', `Only a failed payout can be rescheduled (this one is ${settlement.status})`);
  }
  const pa = await currentAccount(settlement.restaurantId);
  if (pa?.status !== 'verified' || !accountFingerprint(pa)) {
    throw new ApiError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', "The restaurant's bank account is not verified");
  }
  const day = scheduledFor ? await releaseDay(scheduledFor) : await defaultReleaseDay();
  const now = new Date();
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'failed' },
    {
      $set: {
        status: 'approved',
        approvedBy: adminId,
        approvedAt: now,
        'payout.scheduledFor': day,
        'payout.scheduledAt': now,
        'payout.scheduledBy': adminId,
        'payout.beneficiary': beneficiarySnapshot(pa),
        // The next attempt starts clean; the failed one is in lastFailure and history.
        'payout.attemptRef': null,
        'payout.releasedAt': null,
        'payout.releasedBy': null,
        'payout.batchId': null,
        'payout.reference': null,
        'payout.utr': null,
        'payout.paidAt': null,
        'payout.creditedAt': null,
      },
    },
    { new: true }
  );
  if (!updated) throw await refusal(id, () => null);
  await logActivity({ adminId, action: 'settlement.reschedule', targetType: 'settlement', targetId: updated._id, metadata: { scheduledFor: day } });
  return updated;
};

const attemptRefFor = async (now = new Date()) => {
  const ymd = localDay(now, await zoneOf()).replace(/-/g, '');
  const seq = await nextSequence(`payout-attempt:${ymd}`);
  return `YULO-ATT-${ymd}-${String(seq).padStart(3, '0')}`;
};

/**
 * Release: the admin is sending the transfer (net banking). Scheduled → processing; the
 * restaurant sees Processing. Refused if the bank account is no longer the verified one the
 * payout was scheduled for, or — when the admin confirms an amount — if the amount changed.
 * Releasing does not mark it paid.
 */
export const releaseSettlement = async (id, adminId, { expectedNetPaise } = {}) => {
  const settlement = await loadSettlement(id);
  if (settlement.status !== 'approved') {
    throw new ApiError(409, 'NOT_SCHEDULED', `Only a scheduled payout can be released (this one is ${settlement.status})`);
  }
  if (expectedNetPaise != null && expectedNetPaise !== settlement.totals.netPayable) {
    throw new ApiError(409, 'AMOUNT_CHANGED', 'The payout amount changed — review it again before releasing', {
      netPayable: settlement.totals.netPayable,
    });
  }
  const pa = await currentAccount(settlement.restaurantId);
  const snapshot = settlement.payout?.beneficiary?.fingerprint ?? null;
  // A payout approved before B12 has no snapshot: it is released to the account verified now.
  const problem = snapshot
    ? beneficiaryProblem(settlement, { payoutAccount: pa })
    : pa?.status === 'verified' && accountFingerprint(pa)
      ? null
      : 'The bank account is not verified';
  if (problem) throw new ApiError(409, 'BENEFICIARY_CHANGED', `${problem} — check the account and schedule again`);

  const now = new Date();
  const attemptRef = await attemptRefFor(now);
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'approved', 'payout.beneficiary.fingerprint': snapshot },
    {
      $set: {
        ...(snapshot ? {} : { 'payout.beneficiary': beneficiarySnapshot(pa) }),
        status: 'processing',
        'payout.provider': 'manual',
        'payout.attemptRef': attemptRef,
        'payout.releasedAt': now,
        'payout.releasedBy': adminId,
        'payout.initiatedAt': now,
        'payout.failureReason': null,
        'payout.failedAt': null,
      },
      $inc: { 'payout.attempts': 1 },
    },
    { new: true }
  );
  if (!updated) throw await refusal(id, () => null);
  await logActivity({
    adminId,
    action: 'settlement.release',
    targetType: 'settlement',
    targetId: updated._id,
    metadata: { attemptRef, netPayable: updated.totals.netPayable, accountNumberLast4: updated.payout.beneficiary?.accountNumberLast4 ?? null },
  });
  return updated;
};

/**
 * Mark as paid: the bank reference (the UTR the admin reads off the bank) and the date the
 * money was credited. Processing → paid.
 */
export const recordPayoutPaid = async (id, { bankReference, creditedAt }, adminId) => {
  const ref = String(bankReference ?? '').trim();
  if (ref.length < 4) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter the bank reference to continue.');
  const settlement = await loadSettlement(id);
  if (settlement.status !== 'processing') {
    throw new ApiError(409, 'NOT_PROCESSING', `Only a released payout can be marked paid (this one is ${settlement.status})`);
  }
  const timezone = await zoneOf();
  const credited = creditedAt ? new Date(creditedAt) : new Date();
  if (Number.isNaN(credited.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid date credited');
  if (credited.getTime() > dayBounds(new Date(), { timezone }).end.getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The date credited cannot be in the future');
  }
  const released = settlement.payout?.releasedAt ?? settlement.payout?.initiatedAt;
  if (released && credited.getTime() < dayBounds(released, { timezone }).start.getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The date credited cannot be before the payout was released');
  }
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'processing' },
    {
      $set: {
        status: 'paid',
        'payout.utr': ref,
        'payout.paidAt': new Date(),
        'payout.creditedAt': credited,
        'payout.failureReason': null,
        'payout.markedPaidBy': adminId,
      },
    },
    { new: true }
  );
  if (!updated) throw await refusal(id, () => null);
  await logActivity({
    adminId,
    action: 'settlement.mark_paid',
    targetType: 'settlement',
    targetId: updated._id,
    metadata: { bankReference: ref, creditedAt: credited, netPayable: updated.totals.netPayable, attemptRef: updated.payout.attemptRef },
  });
  return updated;
};

/**
 * Mark as failed: the bank rejected the credit. The money stays in this statement — eligible,
 * unpaid, no fee, no automatic retry; the admin reschedules.
 */
export const recordPayoutFailed = async (id, { reason, note }, adminId) => {
  if (!FAILURE_REASONS[reason]) {
    throw new ApiError(400, 'VALIDATION_ERROR', `reason must be one of ${Object.keys(FAILURE_REASONS).join(', ')}`);
  }
  const cleanNote = note ? String(note).trim() : '';
  if (reason === 'other' && cleanNote.length < 3) throw new ApiError(400, 'VALIDATION_ERROR', 'Describe the failure');
  const settlement = await loadSettlement(id);
  if (settlement.status !== 'processing') {
    throw new ApiError(409, 'NOT_PROCESSING', `Only a released payout can be marked failed (this one is ${settlement.status})`);
  }
  const at = new Date();
  const failureReason = cleanNote ? `${FAILURE_REASONS[reason]}: ${cleanNote}` : FAILURE_REASONS[reason];
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'processing' },
    {
      $set: {
        status: 'failed',
        'payout.failureReason': failureReason,
        'payout.failedAt': at,
        'payout.lastFailure': { reason, note: cleanNote || null, at, attemptRef: settlement.payout?.attemptRef ?? settlement.payout?.reference ?? null },
        'payout.utr': null,
        'payout.paidAt': null,
        'payout.creditedAt': null,
      },
      $push: {
        'payout.history': {
          batchId: settlement.payout?.batchId ?? null,
          reference: settlement.payout?.reference ?? null,
          attemptRef: settlement.payout?.attemptRef ?? null,
          outcome: 'failed',
          failedAt: at,
          reason: failureReason,
        },
      },
    },
    { new: true }
  );
  if (!updated) throw await refusal(id, () => null);
  logger.error({ settlementId: updated._id, reason }, 'SETTLEMENT PAYOUT FAILED — reschedule it from the admin console');
  await logActivity({ adminId, action: 'settlement.mark_failed', targetType: 'settlement', targetId: updated._id, metadata: { reason, note: cleanNote || null } });
  return updated;
};

const HOLDABLE = ['draft', 'approved', 'failed'];

/**
 * Place on hold, with a reason code and a staff-only note. Allowed while not scheduled,
 * scheduled (the date is cleared — releasing the hold makes it eligible, not scheduled) or
 * failed. Never once released: the money is with the bank.
 */
export const holdSettlement = async (id, adminId, { reason = 'other', note } = {}) => {
  if (!HOLD_REASONS[reason]) throw new ApiError(400, 'VALIDATION_ERROR', `reason must be one of ${Object.keys(HOLD_REASONS).join(', ')}`);
  const cleanNote = note ? String(note).trim() : null;
  await loadSettlement(id);
  // Conditional: a release claiming it (approved → processing) at the same moment wins, and the
  // hold is refused rather than leaving a payout that is with the bank "on hold".
  const settlement = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: { $in: HOLDABLE }, ...lockFree() },
    {
      $set: {
        status: 'on_hold',
        holdReason: 'MANUAL',
        holdCode: reason,
        holdNote: cleanNote,
        heldAt: new Date(),
        heldBy: adminId,
        approvedBy: null,
        approvedAt: null,
        'payout.scheduledFor': null,
      },
    },
    { new: true }
  );
  if (!settlement) {
    throw await refusal(id, (s) =>
      HOLDABLE.includes(s.status) ? null : new ApiError(409, 'NOT_HOLDABLE', `A ${s.status} settlement cannot be put on hold`)
    );
  }
  await logActivity({ adminId, action: 'settlement.hold', targetType: 'settlement', targetId: settlement._id, metadata: { reason, note: cleanNote } });
  return settlement;
};

/** Update reason: a held payout's reason code / internal note. */
export const updateHoldReason = async (id, adminId, { reason, note }) => {
  if (!HOLD_REASONS[reason]) throw new ApiError(400, 'VALIDATION_ERROR', `reason must be one of ${Object.keys(HOLD_REASONS).join(', ')}`);
  await loadSettlement(id);
  const cleanNote = note ? String(note).trim() : null;
  const settlement = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'on_hold', holdReason: 'MANUAL' },
    { $set: { holdCode: reason, holdNote: cleanNote } },
    { new: true }
  );
  if (!settlement) {
    throw await refusal(id, () => new ApiError(409, 'NOT_MANUALLY_HELD', 'Only a payout held by an admin has a reason to update'));
  }
  await logActivity({ adminId, action: 'settlement.hold_reason', targetType: 'settlement', targetId: settlement._id, metadata: { reason, note: cleanNote } });
  return settlement;
};

/**
 * Release hold: back to eligible, not scheduled (the admin picks the date again). The data then
 * decides between draft and an automatic hold (negative week, unverified account).
 */
export const unholdSettlement = async (id, adminId) => {
  await loadSettlement(id);
  const settlement = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: 'on_hold', holdReason: 'MANUAL', ...lockFree() },
    { $set: { holdReason: null, holdCode: null, holdNote: null, heldAt: null, heldBy: null, 'payout.scheduledFor': null } },
    { new: true }
  );
  if (!settlement) {
    throw await refusal(id, (s) =>
      s.status === 'on_hold' && s.holdReason === 'MANUAL'
        ? null
        : new ApiError(409, 'NOT_MANUALLY_HELD', 'Only a settlement held by an admin can be released')
    );
  }
  await regenerate(settlement);
  await logActivity({ adminId, action: 'settlement.unhold', targetType: 'settlement', targetId: settlement._id });
  return RestaurantSettlement.findById(id);
};

/**
 * Pre-B12 "mark paid": the money was sent outside the release flow (net banking) and is
 * recorded with its UTR in one step, from scheduled, released or failed. Kept for the existing
 * endpoint; the design's flow is release → recordPayoutPaid.
 */
export const markPaidManually = async (id, utr, adminId, { creditedAt } = {}) => {
  if (!utr || !String(utr).trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'A UTR / bank reference is required');
  const settlement = await loadSettlement(id);
  if (!['approved', 'processing', 'failed'].includes(settlement.status)) {
    throw new ApiError(409, 'NOT_PAYABLE', `Schedule the payout first (it is ${settlement.status})`);
  }
  const now = new Date();
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: id, status: { $in: ['approved', 'processing', 'failed'] } },
    {
      $set: {
        status: 'paid',
        // Paid by hand — even if it was on a bank batch before. Reconciling that batch's file
        // again must not treat this payment as the bank's (payoutBatch.service.js).
        'payout.provider': 'manual',
        'payout.utr': String(utr).trim(),
        'payout.paidAt': now,
        'payout.creditedAt': creditedAt ? new Date(creditedAt) : now,
        'payout.releasedAt': settlement.payout?.releasedAt ?? now,
        'payout.failureReason': null,
        'payout.markedPaidBy': adminId,
      },
    },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'CONCURRENT_UPDATE', 'The settlement changed — please refresh');
  await logActivity({
    adminId,
    action: 'settlement.mark_paid',
    targetType: 'settlement',
    targetId: updated._id,
    metadata: { utr: updated.payout.utr, netPayable: updated.totals.netPayable },
  });
  return updated;
};

/**
 * A manual ledger row for a restaurant — a correction (credit or debit) or a penalty (always a
 * debit, no GST). Lands in the current week's settlement.
 */
export const addAdjustment = async ({ restaurantId, amountPaise, direction, kind = 'correction', note, adminId }) => {
  if (!mongoose.isValidObjectId(restaurantId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid restaurant id');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'amountPaise must be a positive whole number of paise');
  }
  if (amountPaise > MAX_ADJUSTMENT_PAISE) {
    throw new ApiError(400, 'VALIDATION_ERROR', `An adjustment can be at most ₹${MAX_ADJUSTMENT_PAISE / 100} — split a larger one`);
  }
  if (!['credit', 'debit'].includes(direction)) throw new ApiError(400, 'VALIDATION_ERROR', 'direction must be credit or debit');
  if (!['correction', 'penalty'].includes(kind)) throw new ApiError(400, 'VALIDATION_ERROR', 'kind must be correction or penalty');
  if (kind === 'penalty' && direction !== 'debit') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A penalty is always a debit');
  }
  if (!note || !String(note).trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'A note explaining the adjustment is required');
  if (!(await Restaurant.exists({ _id: restaurantId }))) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  const entry = await RestaurantLedgerEntry.create({
    restaurantId,
    type: 'adjustment',
    direction,
    amountPaise,
    // Penalties carry no GST (§ Business rules); a correction is a plain money movement.
    breakdown: { kind, gst: 0 },
    eligibleAt: new Date(),
    clearsAt: new Date(),
    createdBy: adminId,
    note: String(note).trim(),
  });
  await logActivity({
    adminId,
    action: `settlement.adjustment.${kind}`,
    targetType: 'restaurant',
    targetId: restaurantId,
    metadata: { amountPaise, direction, note: entry.note, entryId: entry._id },
  });
  return entry;
};

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * A settlement as the restaurant sees it: the documented fields and both status axes — no
 * admin/payout internals. The admin's hold note is staff-only (never here); the hold's reason
 * is shown as its label.
 */
export const ownerViewOfSettlement = (s, { timezone = 'Asia/Kolkata' } = {}) => {
  const transfer = transferOf(s);
  return {
    _id: s._id,
    restaurantId: s.restaurantId,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    status: s.status,
    eligibility: eligibilityOf(s),
    transfer: {
      status: transfer.status,
      label: transfer.label,
      scheduledFor: transfer.scheduledFor,
      paidAt: transfer.paidAt,
      bankReference: transfer.bankReference,
      lastFailure: transfer.lastFailure ? { label: transfer.lastFailure.label, at: transfer.lastFailure.at } : null,
    },
    ownerView: ownerViewOf(s, { timezone }),
    totals: s.totals,
    entryCount: s.entryCount,
    clearedAt: s.clearedAt ?? null,
    payout: {
      provider: s.payout?.provider ?? null,
      utr: transfer.bankReference,
      initiatedAt: s.payout?.releasedAt ?? s.payout?.initiatedAt ?? null,
      paidAt: transfer.paidAt,
      destinationLast4: s.payout?.beneficiary?.accountNumberLast4 ?? null,
    },
    holdReason: s.holdReason ?? null,
    holdLabel: holdLabelOf(s),
    approvedAt: s.approvedAt ?? null,
  };
};

export const listSettlements = async ({ restaurantId, status, weekStart, page = 1, limit = 20 }) => {
  const filter = {};
  if (restaurantId) filter.restaurantId = restaurantId;
  if (status) filter.status = status;
  if (weekStart) {
    const settings = await getActiveSettings();
    filter.periodStart = weekBounds(weekStart, settings.settlementCycle).start;
  }
  const [settlements, total] = await Promise.all([
    RestaurantSettlement.find(filter)
      .sort({ periodStart: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('restaurantId', 'name')
      .lean(),
    RestaurantSettlement.countDocuments(filter),
  ]);
  return { settlements, total, page, limit };
};

/**
 * A settlement with every row in it. `platformTotals` (admin only) adds what the restaurant
 * never sees: Razorpay's fees on its payments, Yulo's margin on the settlement charge, and the
 * riders' pay.
 */
export const getSettlementDetail = async (id) => {
  const settlement = await loadSettlement(id);
  const entries = await RestaurantLedgerEntry.find({ settlementId: settlement._id })
    .sort({ eligibleAt: 1, _id: 1 })
    .lean();
  const platformTotals = entries.reduce(
    (acc, e) => {
      acc.gatewayFees += e.breakdown?.gateway?.total ?? 0;
      acc.yuloSettlementMargin += e.breakdown?.yuloSettlementMargin ?? 0;
      acc.riderPay += e.breakdown?.riderPay ?? 0;
      return acc;
    },
    { gatewayFees: 0, yuloSettlementMargin: 0, riderPay: 0 }
  );
  return { settlement: settlement.toObject(), entries, platformTotals };
};

export const nextWeekStartAfter = (periodEnd) => new Date(periodEnd.getTime() + 1);
export const previousWeekStart = (now, cycle) => weekBounds(new Date(weekBounds(now, cycle).start.getTime() - DAY_MS), cycle).start;
