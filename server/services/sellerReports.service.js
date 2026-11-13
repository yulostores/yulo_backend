import mongoose from 'mongoose';
import { z } from 'zod';
import Coupon from '../models/Coupon.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import { sellerSubscriptions } from './sellerSubscription.service.js';
import { ageBand, ageBandLabel, AGE_BANDS, AGE_BAND_UNDER_18, AGE_BAND_NOT_GIVEN, genderLabel } from '../utils/couponCode.js';
import { GENDERS } from '../config/coupon.config.js';
import { ApiError } from '../utils/ApiError.js';

// The seller portal's dashboard and reports (COUPON_IMPLEMENTATION_PROMPTS.md § CB8).
//
// Visibility (§ Business rules): a seller sees its own CUSTOMER coupons only — every query here
// is { sellerId, kind: 'customer' } — and a customer only as a masked name, a gender and an age
// band. Never a phone, a customer id, a date of birth, or the coupon code (an unredeemed code in
// a report would let anyone at the shop redeem it). Every coupon row a seller receives goes
// through toSellerCouponView, so there is one place that decides what leaves.
//
// Dates are reckoned in India: filters take calendar dates (YYYY-MM-DD, IST) and trend buckets
// are IST days, Monday-start weeks and months.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SELLER_REPORT_STATUSES = ['issued', 'redeemed', 'expired', 'void'];
export const AGE_BAND_ORDER = [AGE_BAND_UNDER_18, ...AGE_BANDS, AGE_BAND_NOT_GIVEN];
const GENDER_ORDER = [...GENDERS, 'not_given'];

// ── The one coupon row ────────────────────────────────────────────────────────

/** "Priya Sharma" → "Priya S."; one word stays as it is; nothing → null. */
export const maskName = (name) => {
  const parts = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.`;
};

export const effectiveStatus = (coupon, now) => (coupon.status === 'issued' && coupon.expiresAt <= now ? 'expired' : coupon.status);

/**
 * The only shape a coupon takes in any seller response. `names` maps SellerUser id → name and
 * `categories` CouponCategory id → name.
 */
export const toSellerCouponView = (coupon, { names = new Map(), categories = new Map(), now = new Date() } = {}) => ({
  id: coupon._id,
  customerName: maskName(coupon.customerSnapshot?.name),
  gender: coupon.customerSnapshot?.gender ?? null,
  // The customer's age band when the coupon was issued.
  ageBand: ageBand(coupon.customerSnapshot?.dateOfBirth, coupon.issuedAt),
  offerTitle: coupon.offerSnapshot?.title ?? null,
  category: categories.get(String(coupon.categoryId)) ?? null,
  issuedAt: coupon.issuedAt,
  expiresAt: coupon.expiresAt,
  status: effectiveStatus(coupon, now),
  redeemedAt: coupon.redeemedAt ?? null,
  redeemedByName: coupon.redeemedBy ? (names.get(String(coupon.redeemedBy)) ?? null) : null,
});

// The fields toSellerCouponView reads — and nothing else is ever selected for a seller.
const VIEW_FIELDS = 'customerSnapshot.name customerSnapshot.gender customerSnapshot.dateOfBirth offerSnapshot.title categoryId issuedAt expiresAt status redeemedAt redeemedBy';

const lookups = async (rows) => {
  const userIds = [...new Set(rows.map((r) => r.redeemedBy).filter(Boolean).map(String))];
  const categoryIds = [...new Set(rows.map((r) => String(r.categoryId)))];
  const [users, cats] = await Promise.all([
    userIds.length ? SellerUser.find({ _id: { $in: userIds } }).select('name').lean() : [],
    categoryIds.length ? CouponCategory.find({ _id: { $in: categoryIds } }).select('name').lean() : [],
  ]);
  return { names: new Map(users.map((u) => [String(u._id), u.name])), categories: new Map(cats.map((c) => [String(c._id), c.name])) };
};

const viewsOf = async (rows, now = new Date()) => {
  const maps = await lookups(rows);
  return rows.map((r) => toSellerCouponView(r, { ...maps, now }));
};

// ── Filters ───────────────────────────────────────────────────────────────────

const istDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a real date');

export const istDateSchema = istDate;

export const reportFilterSchema = z
  .object({
    from: istDate.optional(),
    to: istDate.optional(),
    status: z.enum(SELLER_REPORT_STATUSES).optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: '`from` must not be after `to`', path: ['from'] });

/** Midnight IST at the start of a YYYY-MM-DD date, as a UTC instant. */
export const istMidnight = (ymd) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - IST_OFFSET_MS);

/** The issuedAt range for a { from, to } of IST dates, `to` inclusive. */
export const issuedRange = ({ from, to }) => {
  const range = {};
  if (from) range.$gte = istMidnight(from);
  if (to) range.$lt = new Date(istMidnight(to).getTime() + DAY_MS);
  return Object.keys(range).length ? range : null;
};

export const statusFilter = (status, now) => {
  if (status === 'issued') return { status: 'issued', expiresAt: { $gt: now } };
  if (status === 'expired') return { $or: [{ status: 'expired' }, { status: 'issued', expiresAt: { $lte: now } }] };
  if (status) return { status };
  return {};
};

const own = (sellerId) => ({ sellerId: new mongoose.Types.ObjectId(String(sellerId)), kind: 'customer' });

/** The Mongo filter for a seller's report: their customer coupons issued in range, by status. */
export const reportFilter = (sellerId, { from, to, status } = {}, now = new Date()) => {
  const range = issuedRange({ from, to });
  return { ...own(sellerId), ...(range ? { issuedAt: range } : {}), ...statusFilter(status, now) };
};

// ── Counts ────────────────────────────────────────────────────────────────────

/** issued (all not void), active (issued, not yet expired), redeemed, expired, void. */
export const statusCounts = async (filter, now = new Date()) => {
  const rows = await Coupon.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        void: { $sum: { $cond: [{ $eq: ['$status', 'void'] }, 1, 0] } },
        redeemed: { $sum: { $cond: [{ $eq: ['$status', 'redeemed'] }, 1, 0] } },
        expired: {
          $sum: {
            $cond: [{ $or: [{ $eq: ['$status', 'expired'] }, { $and: [{ $eq: ['$status', 'issued'] }, { $lte: ['$expiresAt', now] }] }] }, 1, 0],
          },
        },
        active: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'issued'] }, { $gt: ['$expiresAt', now] }] }, 1, 0] } },
      },
    },
  ]);
  const r = rows[0] ?? { total: 0, void: 0, redeemed: 0, expired: 0, active: 0 };
  const issued = r.total - r.void;
  return {
    issued,
    active: r.active,
    redeemed: r.redeemed,
    expired: r.expired,
    void: r.void,
    // Of the coupons customers kept (voided ones never could be used), how many were used.
    redemptionRate: issued > 0 ? Math.round((r.redeemed / issued) * 10_000) / 100 : 0,
  };
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

/** GET /api/seller/dashboard */
export const dashboard = async (sellerId) => {
  const now = new Date();
  const [subs, counts, recent] = await Promise.all([
    sellerSubscriptions(sellerId),
    statusCounts(own(sellerId), now),
    Coupon.find(own(sellerId)).sort({ issuedAt: -1, _id: -1 }).limit(10).select(VIEW_FIELDS).lean(),
  ]);
  const activePlans = subs.subscriptions.filter((s) => s.status === 'active');
  return {
    plans: activePlans,
    currentPlan: subs.currentPlan,
    activePlans: subs.activePlans,
    stock: {
      allocated: subs.stock.allocated,
      issued: subs.stock.issued,
      // Coupons still to be given out — what the seller has left to receive customers through.
      pending: subs.stock.remaining,
    },
    coupons: counts,
    redemptionRate: counts.redemptionRate,
    recentCoupons: await viewsOf(recent, now),
  };
};

// ── Reports ───────────────────────────────────────────────────────────────────

/** GET /api/seller/reports/demographics — gender and age-band counts, plus the status counts. */
export const demographics = async (sellerId, filters) => {
  const now = new Date();
  return { filters, ...(await demographicsFor(reportFilter(sellerId, filters, now), now)) };
};

/** Gender and age-band counts (age on the day of issue) for any coupon filter. */
export const demographicsFor = async (filter, now = new Date()) => {
  const [counts, people] = await Promise.all([
    statusCounts(filter, now),
    Coupon.find(filter).select('customerSnapshot.gender customerSnapshot.dateOfBirth issuedAt').lean(),
  ]);
  const gender = Object.fromEntries(GENDER_ORDER.map((g) => [g, 0]));
  const ageBands = Object.fromEntries(AGE_BAND_ORDER.map((b) => [b, 0]));
  for (const p of people) {
    gender[GENDERS.includes(p.customerSnapshot?.gender) ? p.customerSnapshot.gender : 'not_given'] += 1;
    ageBands[ageBand(p.customerSnapshot?.dateOfBirth, p.issuedAt)] += 1;
  }
  return { total: people.length, counts, gender, ageBands };
};

// IST calendar parts of an instant.
const istParts = (d) => {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), dow: s.getUTCDay() };
};
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** The bucket label an instant falls in: an IST day, the Monday starting its IST week, or a month. */
export const bucketOf = (instant, interval) => {
  const { y, m, d, dow } = istParts(instant);
  if (interval === 'month') return ymd(y, m, 1).slice(0, 7);
  if (interval === 'week') return ymd(y, m, d - ((dow + 6) % 7));
  return ymd(y, m, d);
};

// Every bucket label from `from` to `to` (IST dates), in order.
const bucketsBetween = (from, to, interval) => {
  const labels = [];
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const seen = new Set();
  while (cursor <= end) {
    const label = bucketOf(new Date(cursor.getTime() - IST_OFFSET_MS), interval);
    if (!seen.has(label)) {
      seen.add(label);
      labels.push(label);
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return labels;
};

// Default chart: the last 30 days, the last 12 weeks, or the last 12 months — whole weeks and
// months, so the first bucket is never a partial one (a plain 365 days back spans 13 months).
const DEFAULT_BUCKETS = { day: 30, week: 12, month: 12 };
const defaultStart = (end, interval) => {
  const n = DEFAULT_BUCKETS[interval];
  if (interval === 'day') return addDays(end, -(n - 1));
  if (interval === 'week') return addDays(bucketOf(istMidnight(end), 'week'), -7 * (n - 1));
  const [y, m] = end.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - (n - 1), 1)).toISOString().slice(0, 10);
};
const MAX_SPAN_DAYS = { day: 366, week: 3 * 366, month: 5 * 366 };

const addDays = (ymdText, days) => new Date(new Date(`${ymdText}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);

const todayIst = () => {
  const { y, m, d } = istParts(new Date());
  return ymd(y, m, d);
};

export const trendsQuerySchema = z.object({ interval: z.enum(['day', 'week', 'month']).default('day') });

/**
 * GET /api/seller/reports/trends?interval=day|week|month&from&to&status — coupons issued per
 * bucket (by issue date; `status` narrows them) next to coupons redeemed per bucket (by
 * redemption date). Empty buckets are zeros, so a chart needs no gap-filling.
 */
export const trends = (sellerId, opts = {}) => trendsFor(own(sellerId), opts);

/** Issued-vs-redeemed buckets for any base coupon filter (a seller's, or the admin's). */
export const trendsFor = async (base, { interval = 'day', from, to, status } = {}) => {
  const end = to ?? todayIst();
  const start = from ?? defaultStart(end, interval);
  const spanDays = (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / DAY_MS + 1;
  if (spanDays > MAX_SPAN_DAYS[interval]) {
    throw new ApiError(400, 'VALIDATION_ERROR', `That range is too long for a ${interval} chart — pick a shorter range or a wider interval`);
  }
  const now = new Date();
  const range = { $gte: istMidnight(start), $lt: new Date(istMidnight(end).getTime() + DAY_MS) };
  const [issuedRows, redeemedRows] = await Promise.all([
    Coupon.find({ ...base, issuedAt: range, ...statusFilter(status, now) }).select('issuedAt').lean(),
    status && status !== 'redeemed'
      ? []
      : Coupon.find({ ...base, status: 'redeemed', redeemedAt: range }).select('redeemedAt').lean(),
  ]);
  const labels = bucketsBetween(start, end, interval);
  const issued = Object.fromEntries(labels.map((l) => [l, 0]));
  const redeemed = Object.fromEntries(labels.map((l) => [l, 0]));
  for (const r of issuedRows) issued[bucketOf(r.issuedAt, interval)] += 1;
  for (const r of redeemedRows) redeemed[bucketOf(r.redeemedAt, interval)] += 1;
  return {
    interval,
    from: start,
    to: end,
    status: status ?? null,
    series: labels.map((label) => ({ bucket: label, issued: issued[label], redeemed: redeemed[label] })),
    totals: { issued: issuedRows.length, redeemed: redeemedRows.length },
  };
};

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET /api/seller/reports/coupons — newest first. */
export const couponList = async (sellerId, filters, { page = 1, limit = 25 } = {}) => {
  const now = new Date();
  const filter = reportFilter(sellerId, filters, now);
  const [rows, total] = await Promise.all([
    Coupon.find(filter).sort({ issuedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select(VIEW_FIELDS).lean(),
    Coupon.countDocuments(filter),
  ]);
  return { filters, coupons: await viewsOf(rows, now), total, page, limit };
};

// ── CSV ───────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  ['Customer', (v) => v.customerName ?? 'Not given'],
  ['Gender', (v) => genderLabel(v.gender)],
  ['Age band', (v) => ageBandLabel(v.ageBand)],
  ['Offer', (v) => v.offerTitle],
  ['Category', (v) => v.category],
  ['Issued (IST)', (v) => istDateTime(v.issuedAt)],
  ['Expires (IST)', (v) => istDateTime(v.expiresAt)],
  ['Status', (v) => v.status],
  ['Redeemed (IST)', (v) => istDateTime(v.redeemedAt)],
  ['Redeemed by', (v) => v.redeemedByName],
];

const istDateTime = (d) => (d ? new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '');

// Quotes every cell and neutralises spreadsheet formulas (a name typed as "=HYPERLINK(...)").
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

const CSV_MAX_ROWS = 50_000;

/** GET /api/seller/reports/coupons.csv — the same rows as the list (same serializer), all of them. */
export const couponsCsv = async (sellerId, filters) => {
  const now = new Date();
  const rows = await Coupon.find(reportFilter(sellerId, filters, now))
    .sort({ issuedAt: -1, _id: -1 })
    .limit(CSV_MAX_ROWS)
    .select(VIEW_FIELDS)
    .lean();
  const views = await viewsOf(rows, now);
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const v of views) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(v))).join(','));
  return `${lines.join('\r\n')}\r\n`;
};
