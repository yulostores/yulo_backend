import mongoose from 'mongoose';
import { z } from 'zod';
import Coupon from '../models/Coupon.js';
import User from '../models/User.js';
import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import CouponOffer from '../models/CouponOffer.js';
import SellerSubscription from '../models/SellerSubscription.js';
import { GENDERS, COUPON_KINDS, COUPON_VALIDITY_DAYS } from '../config/coupon.config.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { takeOne, giveBack } from './sellerSubscription.service.js';
import { logActivity } from './activityLog.service.js';
import {
  effectiveStatus,
  statusFilter,
  istMidnight,
  istDateSchema,
  AGE_BAND_ORDER,
} from './sellerReports.service.js';
import { generateCouponCode, normalizeCouponCode, ageOn, genderLabel } from '../utils/couponCode.js';
import { normalizeIndianPhone } from '../utils/phone.js';
import { escapeRegExp } from '../utils/regex.js';
import { ApiError } from '../utils/ApiError.js';

// The super admin's view of every coupon (§ CB9): the filtered list and its CSV export,
// complimentary coupons (assign to a team member, mark used) and manual issue.
//
// Unlike the seller views, the admin sees the customer's mobile number (for WhatsApp reminders)
// and complimentary coupons. Age is the customer's age on the day the coupon was issued — the same
// figure every coupon report uses — reckoned on India's calendar.

const DAY_MS = 24 * 60 * 60 * 1000;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const parseOr400 = (schema, input, message = 'Invalid filters') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? message, flat);
  }
  return parsed.data;
};

// ── Filters ───────────────────────────────────────────────────────────────────

export const ADMIN_COUPON_SORTS = ['issuedAt', '-issuedAt', 'expiresAt', '-expiresAt', 'redeemedAt', '-redeemedAt'];

export const adminCouponFilterSchema = z
  .object({
    category: objectId.optional(),
    seller: objectId.optional(),
    status: z.enum(['issued', 'redeemed', 'expired', 'void']).optional(),
    kind: z.enum(COUPON_KINDS).optional(),
    issuedFrom: istDateSchema.optional(),
    issuedTo: istDateSchema.optional(),
    expiringFrom: istDateSchema.optional(),
    expiringTo: istDateSchema.optional(),
    gender: z.enum([...GENDERS, 'not_given']).optional(),
    ageBand: z.enum(AGE_BAND_ORDER).optional(),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const adminCouponListSchema = adminCouponFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.enum(ADMIN_COUPON_SORTS).default('-issuedAt'),
});

export const parseListQuery = (query) => parseOr400(adminCouponListSchema, query);
/** The export's filters: the list's, without paging (the file is every matching row). */
export const parseFilterQuery = (query) => {
  const { page: _page, limit: _limit, ...filters } = parseListQuery(query);
  return filters;
};

const dateRange = (from, to) => {
  const range = {};
  if (from) range.$gte = istMidnight(from);
  if (to) range.$lt = new Date(istMidnight(to).getTime() + DAY_MS);
  return Object.keys(range).length ? range : null;
};

// Age in whole years on the issue date, both dates read in India — an aggregation expression so
// the age-band filter runs in the database. null when there is no date of birth.
const AGE_AT_ISSUE = {
  $let: {
    vars: {
      i: { $dateToParts: { date: '$issuedAt', timezone: 'Asia/Kolkata' } },
      b: { $dateToParts: { date: '$customerSnapshot.dateOfBirth', timezone: 'Asia/Kolkata' } },
    },
    in: {
      $cond: [
        { $eq: [{ $ifNull: ['$customerSnapshot.dateOfBirth', null] }, null] },
        null,
        {
          $subtract: [
            { $subtract: ['$$i.year', '$$b.year'] },
            {
              $cond: [
                { $or: [{ $lt: ['$$i.month', '$$b.month'] }, { $and: [{ $eq: ['$$i.month', '$$b.month'] }, { $lt: ['$$i.day', '$$b.day'] }] }] },
                1,
                0,
              ],
            },
          ],
        },
      ],
    },
  },
};

const BAND_LIMITS = { 'under-18': [0, 17], '18-24': [18, 24], '25-34': [25, 34], '35-44': [35, 44], '45-54': [45, 54], '55+': [55, 200] };

const ageBandClause = (band) => {
  if (band === 'not-given') return { 'customerSnapshot.dateOfBirth': null };
  const [lo, hi] = BAND_LIMITS[band];
  return {
    'customerSnapshot.dateOfBirth': { $ne: null },
    $expr: { $and: [{ $gte: [AGE_AT_ISSUE, lo] }, { $lte: [AGE_AT_ISSUE, hi] }] },
  };
};

/**
 * The Mongo filter for the admin coupon list / export. Search matches a coupon code, a customer's
 * (or team member's) mobile number, or a name. Clauses are combined with $and so the status
 * filter's own $or never collides with the search's.
 */
export const buildAdminFilter = async (f, now = new Date()) => {
  const and = [];
  if (f.category) and.push({ categoryId: oid(f.category) });
  if (f.seller) and.push({ sellerId: oid(f.seller) });
  if (f.kind) and.push({ kind: f.kind });
  if (f.status) and.push(statusFilter(f.status, now));
  const issued = dateRange(f.issuedFrom, f.issuedTo);
  if (issued) and.push({ issuedAt: issued });
  const expiring = dateRange(f.expiringFrom, f.expiringTo);
  if (expiring) and.push({ expiresAt: expiring });
  if (f.gender) and.push({ 'customerSnapshot.gender': f.gender === 'not_given' ? null : f.gender });
  if (f.ageBand) and.push(ageBandClause(f.ageBand));

  if (f.search) {
    const or = [];
    const code = normalizeCouponCode(f.search);
    if (code) or.push({ code });
    const digits = f.search.replace(/\D/g, '');
    if (digits.length >= 4) {
      const phone = normalizeIndianPhone(f.search);
      const phonePattern = phone ? `^${phone}$` : escapeRegExp(digits);
      const users = await User.find({ phone: { $regex: phonePattern } }).select('_id').limit(1000).lean();
      if (users.length) or.push({ customerId: { $in: users.map((u) => u._id) } });
      or.push({ 'assignedTo.phone': { $regex: phonePattern } });
    }
    const name = new RegExp(escapeRegExp(f.search), 'i');
    or.push({ 'customerSnapshot.name': name }, { 'assignedTo.name': name });
    and.push({ $or: or });
  }
  return and.length ? { $and: and } : {};
};

const sortOf = (sort) => {
  const field = sort.replace('-', '');
  const dir = sort.startsWith('-') ? -1 : 1;
  return { [field]: dir, _id: dir };
};

// ── Rows ──────────────────────────────────────────────────────────────────────

const ROW_FIELDS = 'code kind sellerId subscriptionId categoryId offerId offerSnapshot customerId customerSnapshot source status issuedAt expiresAt redeemedAt redeemedBy voidedAt assignedTo';

/** Everything the rows of one page (or one export batch) refer to, fetched once. */
const relationsFor = async (rows) => {
  const ids = (pick) => [...new Set(rows.map(pick).filter(Boolean).map(String))];
  const [users, sellers, categories, staff] = await Promise.all([
    User.find({ _id: { $in: ids((r) => r.customerId) } }).select('phone').lean(),
    Seller.find({ _id: { $in: ids((r) => r.sellerId) } }).select('businessName').lean(),
    CouponCategory.find({ _id: { $in: ids((r) => r.categoryId) } }).select('name').lean(),
    SellerUser.find({ _id: { $in: ids((r) => r.redeemedBy) } }).select('name role').lean(),
  ]);
  const map = (list) => new Map(list.map((x) => [String(x._id), x]));
  return { users: map(users), sellers: map(sellers), categories: map(categories), staff: map(staff) };
};

export const toAdminCouponRow = (c, rel, now = new Date()) => {
  const complimentary = c.kind === 'complimentary';
  const seller = rel.sellers.get(String(c.sellerId));
  const category = rel.categories.get(String(c.categoryId));
  const redeemer = c.redeemedBy ? rel.staff.get(String(c.redeemedBy)) : null;
  return {
    id: c._id,
    code: c.code,
    kind: c.kind,
    customerName: complimentary ? c.assignedTo?.name ?? null : c.customerSnapshot?.name ?? null,
    mobile: complimentary ? c.assignedTo?.phone ?? null : rel.users.get(String(c.customerId))?.phone ?? null,
    age: complimentary ? null : ageOn(c.customerSnapshot?.dateOfBirth, c.issuedAt),
    gender: complimentary ? null : c.customerSnapshot?.gender ?? null,
    category: category ? { id: category._id, name: category.name } : null,
    seller: { id: c.sellerId, name: seller?.businessName ?? null },
    offerTitle: c.offerSnapshot?.title ?? null,
    source: c.source?.type ?? null,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    status: effectiveStatus(c, now),
    redeemedAt: c.redeemedAt ?? null,
    redeemedBy: redeemer ? { id: redeemer._id, name: redeemer.name, role: redeemer.role } : null,
    assignedTo: complimentary ? (c.assignedTo?.name ? c.assignedTo : null) : undefined,
  };
};

/** GET /api/admin/coupons */
export const listCoupons = async (query) => {
  const { page, limit, sort, ...filters } = query;
  const now = new Date();
  const filter = await buildAdminFilter(filters, now);
  const [rows, total] = await Promise.all([
    Coupon.find(filter).sort(sortOf(sort)).skip((page - 1) * limit).limit(limit).select(ROW_FIELDS).lean(),
    Coupon.countDocuments(filter),
  ]);
  const rel = await relationsFor(rows);
  return { coupons: rows.map((r) => toAdminCouponRow(r, rel, now)), total, page, limit, sort, filters };
};

// ── CSV export ────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60 * 1000;
const istDateTime = (d) => (d ? new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ') : '');

export const EXPORT_COLUMNS = [
  ['Code', (r) => r.code],
  ['Kind', (r) => r.kind],
  ['Customer', (r) => (r.kind === 'complimentary' ? r.customerName ?? '' : r.customerName || 'Not given')],
  ['Mobile', (r) => r.mobile],
  // Complimentary coupons have no customer: those cells stay empty.
  ['Age', (r) => (r.kind === 'complimentary' ? '' : r.age ?? 'Not given')],
  ['Gender', (r) => (r.kind === 'complimentary' ? '' : genderLabel(r.gender))],
  ['Category', (r) => r.category?.name],
  ['Seller', (r) => r.seller?.name],
  ['Seller ID', (r) => r.seller?.id],
  ['Offer', (r) => r.offerTitle],
  ['Issued (IST)', (r) => istDateTime(r.issuedAt)],
  ['Expires (IST)', (r) => istDateTime(r.expiresAt)],
  ['Status', (r) => r.status],
  ['Redeemed (IST)', (r) => istDateTime(r.redeemedAt)],
  ['Redeemed by', (r) => r.redeemedBy?.name],
];

const EXPORT_BATCH = 500;

/**
 * Streams the export: yields CSV text chunks (header first), EXPORT_BATCH rows at a time, from a
 * database cursor — so a 100k-row export never sits in memory. `cell` is utils/csv.js#csvCell.
 */
export async function* exportCsvChunks(filters, cell) {
  const now = new Date();
  const filter = await buildAdminFilter(filters, now);
  yield `${EXPORT_COLUMNS.map(([h]) => cell(h)).join(',')}\r\n`;
  const cursor = Coupon.find(filter).sort(sortOf(filters.sort ?? '-issuedAt')).select(ROW_FIELDS).lean().cursor({ batchSize: EXPORT_BATCH });
  let batch = [];
  const flush = async () => {
    const rel = await relationsFor(batch);
    const text = batch.map((c) => {
      const row = toAdminCouponRow(c, rel, now);
      return EXPORT_COLUMNS.map(([, get]) => cell(get(row))).join(',');
    });
    batch = [];
    return `${text.join('\r\n')}\r\n`;
  };
  for await (const doc of cursor) {
    batch.push(doc);
    if (batch.length >= EXPORT_BATCH) yield await flush();
  }
  if (batch.length) yield await flush();
}

// ── Complimentary ─────────────────────────────────────────────────────────────

export const complimentaryQuerySchema = z
  .object({
    seller: objectId.optional(),
    subscription: objectId.optional(),
    assigned: z.enum(['true', 'false']).optional(),
    status: z.enum(['issued', 'redeemed', 'expired', 'void']).optional(),
  })
  .strict();

/** GET /api/admin/coupons/complimentary — grouped by seller and plan purchase. */
export const listComplimentary = async (query) => {
  const q = parseOr400(complimentaryQuerySchema, query);
  const now = new Date();
  const and = [{ kind: 'complimentary' }];
  if (q.seller) and.push({ sellerId: oid(q.seller) });
  if (q.subscription) and.push({ subscriptionId: oid(q.subscription) });
  if (q.assigned) and.push({ 'assignedTo.name': q.assigned === 'true' ? { $ne: null } : null });
  if (q.status) and.push(statusFilter(q.status, now));
  const rows = await Coupon.find({ $and: and }).sort({ sellerId: 1, subscriptionId: 1, issuedAt: 1, _id: 1 }).select(ROW_FIELDS).lean();
  const [rel, subs] = await Promise.all([
    relationsFor(rows),
    SellerSubscription.find({ _id: { $in: [...new Set(rows.map((r) => String(r.subscriptionId)))] } }).select('planSnapshot.name planSnapshot.key activatedAt').lean(),
  ]);
  const subById = new Map(subs.map((s) => [String(s._id), s]));
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.subscriptionId);
    if (!groups.has(key)) {
      const sub = subById.get(key);
      groups.set(key, {
        subscriptionId: row.subscriptionId,
        seller: { id: row.sellerId, name: rel.sellers.get(String(row.sellerId))?.businessName ?? null },
        plan: sub ? { key: sub.planSnapshot.key, name: sub.planSnapshot.name } : null,
        activatedAt: sub?.activatedAt ?? null,
        coupons: [],
      });
    }
    const view = toAdminCouponRow(row, rel, now);
    groups.get(key).coupons.push({
      id: view.id,
      code: view.code,
      status: view.status,
      expiresAt: view.expiresAt,
      redeemedAt: view.redeemedAt,
      assignedTo: row.assignedTo?.name ? { name: row.assignedTo.name, phone: row.assignedTo.phone, note: row.assignedTo.note, at: row.assignedTo.at } : null,
    });
  }
  return { groups: [...groups.values()], total: rows.length };
};

export const assignSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the name').max(100),
    phone: z.preprocess((v) => normalizeIndianPhone(v) ?? v, z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

const loadComplimentary = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Complimentary coupon not found');
  const coupon = await Coupon.findOne({ _id: id, kind: 'complimentary' }).lean();
  if (!coupon) throw new ApiError(404, 'NOT_FOUND', 'Complimentary coupon not found');
  return coupon;
};

const refuseUnusable = (coupon) => {
  const status = effectiveStatus(coupon, new Date());
  if (status === 'redeemed') throw new ApiError(409, 'COUPON_ALREADY_REDEEMED', 'This coupon has already been used', { redeemedAt: coupon.redeemedAt });
  if (status === 'expired') throw new ApiError(410, 'COUPON_EXPIRED', 'This coupon has expired');
  if (status === 'void') throw new ApiError(409, 'COUPON_VOID', 'This coupon is void');
};

/** PATCH /api/admin/coupons/complimentary/:id/assign — hand it to a Yulo team member (re-assignable until used). */
export const assignComplimentary = async (id, adminId, body) => {
  const data = parseOr400(assignSchema, body, 'Invalid assignment');
  const coupon = await loadComplimentary(id);
  refuseUnusable(coupon);
  const assignedTo = { name: data.name, phone: data.phone, note: data.note ?? null, at: new Date() };
  const updated = await Coupon.findOneAndUpdate(
    { _id: coupon._id, kind: 'complimentary', status: 'issued' },
    { $set: { assignedTo } },
    { new: true }
  ).lean();
  if (!updated) refuseUnusable(await loadComplimentary(id));
  await logActivity({
    adminId,
    action: 'COUPON_COMPLIMENTARY_ASSIGNED',
    targetType: 'coupon',
    targetId: coupon._id,
    metadata: { sellerId: coupon.sellerId, name: data.name, previous: coupon.assignedTo?.name ?? null },
  });
  return { id: updated._id, code: updated.code, status: updated.status, assignedTo: updated.assignedTo };
};

/** PATCH /api/admin/coupons/complimentary/:id/mark-used — once; the same exactly-once update as redemption. */
export const markComplimentaryUsed = async (id, adminId) => {
  const coupon = await loadComplimentary(id);
  const now = new Date();
  const updated = await Coupon.findOneAndUpdate(
    { _id: coupon._id, kind: 'complimentary', status: 'issued', expiresAt: { $gt: now } },
    { $set: { status: 'redeemed', redeemedAt: now } },
    { new: true }
  ).lean();
  if (!updated) {
    refuseUnusable(await loadComplimentary(id));
    throw new ApiError(409, 'INVALID_STATE', 'This coupon cannot be marked used');
  }
  await logActivity({ adminId, action: 'COUPON_COMPLIMENTARY_USED', targetType: 'coupon', targetId: coupon._id, metadata: { sellerId: coupon.sellerId } });
  return { id: updated._id, code: updated.code, status: updated.status, redeemedAt: updated.redeemedAt, assignedTo: updated.assignedTo };
};

// ── Manual issue ──────────────────────────────────────────────────────────────

export const manualIssueSchema = z
  .object({
    phone: z.preprocess((v) => normalizeIndianPhone(v) ?? v, z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')),
    sellerId: objectId,
    offerId: objectId.optional(),
    note: z.string().trim().max(500).nullish(),
    // A client-made id for this request: a retried or double-clicked submit issues once.
    requestId: z.string().trim().min(8).max(64).regex(/^[\w-]+$/, 'Invalid request id').optional(),
  })
  .strict();

/**
 * POST /api/admin/coupons/issue — one coupon to a customer (by mobile) from a chosen seller, out of
 * that seller's stock like any other. Audit-logged.
 */
export const manualIssue = async (adminId, body) => {
  const data = parseOr400(manualIssueSchema, body, 'Invalid coupon');
  const customer = await User.findOne({ phone: data.phone, role: 'customer' }).select('name gender dateOfBirth isActive').lean();
  if (!customer || customer.isActive === false) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'No customer account with this mobile number');
  const seller = await Seller.findById(data.sellerId).select('status categoryId businessName').lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  if (seller.status !== 'active') throw new ApiError(409, 'SELLER_NOT_ACTIVE', 'This seller is not active');

  const offerFilter = { sellerId: seller._id, status: 'approved', ...(data.offerId ? { _id: oid(data.offerId) } : {}) };
  const offer = await CouponOffer.findOne(offerFilter).sort({ createdAt: 1 }).lean();
  if (!offer) throw new ApiError(409, 'NO_APPROVED_OFFER', data.offerId ? 'That offer is not approved for this seller' : 'This seller has no approved offer');

  const issueKey = data.requestId ? `manual:${data.requestId}` : undefined;
  if (issueKey) {
    const existing = await Coupon.findOne({ issueKey }).select(ROW_FIELDS).lean();
    if (existing) return { coupon: await oneRow(existing), duplicate: true };
  }

  const subscription = await takeOne(seller._id);
  if (!subscription) throw new ApiError(409, 'NO_STOCK', 'This seller has no coupons left to issue');

  const settings = await getActiveCouponSettings();
  const now = new Date();
  const doc = {
    kind: 'customer',
    sellerId: seller._id,
    subscriptionId: subscription._id,
    offerId: offer._id,
    offerSnapshot: { title: offer.title, terms: offer.terms ?? '' },
    categoryId: seller.categoryId,
    customerId: customer._id,
    customerSnapshot: { name: customer.name || null, gender: customer.gender ?? null, dateOfBirth: customer.dateOfBirth ?? null },
    source: { type: 'manual', id: null },
    ...(issueKey ? { issueKey } : {}),
    status: 'issued',
    issuedAt: now,
    expiresAt: new Date(now.getTime() + COUPON_VALIDITY_DAYS * DAY_MS),
  };

  let created;
  try {
    for (let attempt = 1; !created; attempt += 1) {
      try {
        created = (await Coupon.create({ ...doc, code: generateCouponCode() })).toObject();
      } catch (err) {
        if (err?.code === 11000 && err.keyPattern?.code && attempt < 5) continue;
        throw err;
      }
    }
  } catch (err) {
    await giveBack(subscription._id);
    if (err?.code === 11000 && err.keyPattern?.issueKey) {
      return { coupon: await oneRow(await Coupon.findOne({ issueKey }).lean()), duplicate: true };
    }
    throw err;
  }

  await logActivity({
    adminId,
    action: 'COUPON_ISSUED_MANUALLY',
    targetType: 'coupon',
    targetId: created._id,
    metadata: { sellerId: seller._id, customerId: customer._id, subscriptionId: subscription._id, note: data.note ?? null },
  });
  return { coupon: await oneRow(created), duplicate: false };
};

const oneRow = async (coupon) => toAdminCouponRow(coupon, await relationsFor([coupon]));
