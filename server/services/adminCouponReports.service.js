import mongoose from 'mongoose';
import { z } from 'zod';
import Coupon from '../models/Coupon.js';
import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import SellerSubscription from '../models/SellerSubscription.js';
import { statusCounts, demographicsFor, trendsFor, istMidnight, istDateSchema, trendsQuerySchema, SELLER_REPORT_STATUSES } from './sellerReports.service.js';
import { sellerSubscriptionView } from './sellerSubscription.service.js';
import { ApiError } from '../utils/ApiError.js';

// Super admin coupon reports — /api/admin/coupon-reports (§ CB9). Every report takes the same
// filters: issued from/to (IST calendar dates, `to` inclusive), category, seller. Counts are of
// CUSTOMER coupons except where complimentary ones are reported on their own.
//
// The same definitions as the seller reports (services/sellerReports.service.js), so the numbers
// agree everywhere: issued = not void; expired includes coupons past their date that the expiry
// job hasn't marked yet; pending = stock not yet issued; redemption rate = redeemed / issued.

const DAY_MS = 24 * 60 * 60 * 1000;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const oid = (id) => new mongoose.Types.ObjectId(String(id));

export const adminReportFilterSchema = z
  .object({
    from: istDateSchema.optional(),
    to: istDateSchema.optional(),
    category: objectId.optional(),
    seller: objectId.optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: '`from` must not be after `to`', path: ['from'] });

export const parseReportFilters = (query, extra = {}) => {
  const parsed = adminReportFilterSchema.safeParse({ from: query.from, to: query.to, category: query.category, seller: query.seller, ...extra });
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid filters', flat);
  }
  return parsed.data;
};

const issuedRange = ({ from, to }) => {
  const range = {};
  if (from) range.$gte = istMidnight(from);
  if (to) range.$lt = new Date(istMidnight(to).getTime() + DAY_MS);
  return Object.keys(range).length ? range : null;
};

/** Customer (or `kind`) coupons matching the filters. `withRange: false` leaves the dates out (trends). */
const couponMatch = (f, { kind = 'customer', withRange = true } = {}) => {
  const match = { kind };
  if (f.category) match.categoryId = oid(f.category);
  if (f.seller) match.sellerId = oid(f.seller);
  const range = withRange ? issuedRange(f) : null;
  if (range) match.issuedAt = range;
  return match;
};

// Sellers in scope of the filters (for stock, which belongs to sellers, not coupons).
const sellerScope = async (f) => {
  const q = {};
  if (f.seller) q._id = oid(f.seller);
  if (f.category) q.categoryId = oid(f.category);
  return Object.keys(q).length ? (await Seller.find(q).select('_id').lean()).map((s) => s._id) : null;
};

const stockFor = async (sellerIds) => {
  const match = { status: { $in: ['active', 'exhausted'] } };
  if (sellerIds) match.sellerId = { $in: sellerIds };
  const [r] = await SellerSubscription.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        allocated: { $sum: '$allocated' },
        issued: { $sum: '$issued' },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$remaining', 0] } },
      },
    },
  ]);
  return { allocated: r?.allocated ?? 0, issued: r?.issued ?? 0, pending: r?.pending ?? 0 };
};

/** Status counts grouped by a field, in one aggregation. */
const countsBy = async (field, match, now) => {
  const rows = await Coupon.aggregate([
    { $match: match },
    {
      $group: {
        _id: `$${field}`,
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
  return new Map(rows.map((r) => [String(r._id), shape(r)]));
};

const shape = (r) => {
  const issued = (r?.total ?? 0) - (r?.void ?? 0);
  return {
    issued,
    active: r?.active ?? 0,
    redeemed: r?.redeemed ?? 0,
    expired: r?.expired ?? 0,
    void: r?.void ?? 0,
    redemptionRate: issued > 0 ? Math.round(((r?.redeemed ?? 0) / issued) * 10_000) / 100 : 0,
  };
};
const ZERO = shape(null);

// ── Reports ───────────────────────────────────────────────────────────────────

/** summary — issued, pending (stock), active, redeemed, expired, void, and complimentary on its own. */
export const summary = async (f) => {
  const now = new Date();
  const [counts, stock, comp] = await Promise.all([
    statusCounts(couponMatch(f), now),
    sellerScope(f).then(stockFor),
    countsBy('kind', couponMatch(f, { kind: 'complimentary' }), now),
  ]);
  const assigned = await Coupon.countDocuments({ ...couponMatch(f, { kind: 'complimentary' }), 'assignedTo.name': { $ne: null } });
  const c = comp.get('complimentary') ?? ZERO;
  return {
    filters: f,
    ...counts,
    pending: stock.pending,
    stock,
    complimentary: { total: c.issued + c.void, assigned, used: c.redeemed, expired: c.expired, unused: c.active },
  };
};

/** by-category — every category (zeros included), in display order. */
export const byCategory = async (f) => {
  const now = new Date();
  const [categories, counts] = await Promise.all([
    CouponCategory.find(f.category ? { _id: oid(f.category) } : {}).sort({ sortOrder: 1, _id: 1 }).select('key name enabled').lean(),
    countsBy('categoryId', couponMatch(f), now),
  ]);
  return {
    filters: f,
    categories: categories.map((c) => ({ id: c._id, key: c.key, name: c.name, enabled: c.enabled, ...(counts.get(String(c._id)) ?? ZERO) })),
  };
};

/** by-seller — sellers with any coupon in range, most issued first. */
export const bySeller = async (f) => {
  const now = new Date();
  const counts = await countsBy('sellerId', couponMatch(f), now);
  const sellers = await Seller.find({ _id: { $in: [...counts.keys()].map(oid) } }).select('businessName categoryId status').lean();
  const names = new Map(sellers.map((s) => [String(s._id), s]));
  const rows = [...counts.entries()].map(([id, c]) => ({
    id,
    name: names.get(id)?.businessName ?? null,
    status: names.get(id)?.status ?? null,
    ...c,
  }));
  rows.sort((a, b) => b.issued - a.issued || String(a.name).localeCompare(String(b.name)));
  return { filters: f, sellers: rows };
};

/** demographics — gender and age bands (age on the day of issue). */
export const demographics = async (f) => ({ filters: f, ...(await demographicsFor(couponMatch(f))) });

export const adminTrendsSchema = trendsQuerySchema.extend({ status: z.enum(SELLER_REPORT_STATUSES).optional() });

/** trends — issued vs redeemed per IST day / week / month. */
export const trends = async (f, { interval, status }) => trendsFor(couponMatch(f, { withRange: false }), { interval, from: f.from, to: f.to, status });

/**
 * employees — every seller login (removed ones too, marked) with its redemptions in range and
 * the last one. Phone numbers are shown: this is the super admin.
 */
export const employees = async (f) => {
  const userFilter = {};
  if (f.seller) userFilter.sellerId = oid(f.seller);
  else if (f.category) userFilter.sellerId = { $in: (await sellerScope(f)) ?? [] };
  const users = await SellerUser.find(userFilter).sort({ sellerId: 1, role: 1, name: 1 }).select('sellerId name role phone isActive removedAt').lean();
  const match = { status: 'redeemed', redeemedBy: { $in: users.map((u) => u._id) } };
  const range = issuedRange(f);
  if (range) match.redeemedAt = range; // employees are measured by when they redeemed
  const [agg, sellers] = await Promise.all([
    Coupon.aggregate([{ $match: match }, { $group: { _id: '$redeemedBy', redemptions: { $sum: 1 }, lastRedemptionAt: { $max: '$redeemedAt' } } }]),
    Seller.find({ _id: { $in: [...new Set(users.map((u) => String(u.sellerId)))] } }).select('businessName').lean(),
  ]);
  const byUser = new Map(agg.map((a) => [String(a._id), a]));
  const sellerName = new Map(sellers.map((s) => [String(s._id), s.businessName]));
  return {
    filters: f,
    employees: users.map((u) => ({
      id: u._id,
      seller: { id: u.sellerId, name: sellerName.get(String(u.sellerId)) ?? null },
      name: u.name,
      role: u.role,
      phone: u.phone,
      status: u.removedAt ? 'removed' : u.isActive ? 'active' : 'inactive',
      redemptions: byUser.get(String(u._id))?.redemptions ?? 0,
      lastRedemptionAt: byUser.get(String(u._id))?.lastRedemptionAt ?? null,
    })),
  };
};

/** sellers — business info, the current plan and the coupon numbers, for every seller in scope. */
export const sellers = async (f) => {
  const now = new Date();
  const q = {};
  if (f.seller) q._id = oid(f.seller);
  if (f.category) q.categoryId = oid(f.category);
  const list = await Seller.find(q).sort({ businessName: 1 }).select('businessName categoryId status address businessPhone owner.name reviewedAt createdAt').lean();
  const ids = list.map((s) => s._id);
  const [subs, counts, categories] = await Promise.all([
    SellerSubscription.find({ sellerId: { $in: ids }, status: { $in: ['active', 'exhausted'] } }).sort({ activatedAt: 1 }).lean(),
    countsBy('sellerId', { ...couponMatch(f), sellerId: { $in: ids } }, now),
    CouponCategory.find({ _id: { $in: [...new Set(list.map((s) => String(s.categoryId)))] } }).select('name').lean(),
  ]);
  const categoryName = new Map(categories.map((c) => [String(c._id), c.name]));
  const subsBySeller = new Map();
  for (const s of subs) {
    const key = String(s.sellerId);
    if (!subsBySeller.has(key)) subsBySeller.set(key, []);
    subsBySeller.get(key).push(s);
  }
  return {
    filters: f,
    sellers: list.map((s) => {
      const own = subsBySeller.get(String(s._id)) ?? [];
      const current = own.find((x) => x.status === 'active') ?? own.at(-1) ?? null;
      const c = counts.get(String(s._id)) ?? ZERO;
      return {
        id: s._id,
        businessName: s.businessName,
        category: categoryName.get(String(s.categoryId)) ?? null,
        status: s.status,
        city: s.address?.city ?? null,
        businessPhone: s.businessPhone ?? null,
        ownerName: s.owner?.name ?? null,
        approvedAt: s.status === 'active' ? s.reviewedAt ?? null : null,
        currentPlan: current ? sellerSubscriptionView(current).plan : null,
        activePlans: own.filter((x) => x.status === 'active').map((x) => ({ key: x.planSnapshot.key, name: x.planSnapshot.name })),
        allocated: own.reduce((n, x) => n + x.allocated, 0),
        issued: own.reduce((n, x) => n + x.issued, 0),
        pending: own.filter((x) => x.status === 'active').reduce((n, x) => n + x.remaining, 0),
        redeemed: c.redeemed,
        expired: c.expired,
        void: c.void,
        redemptionRate: c.redemptionRate,
      };
    }),
  };
};
