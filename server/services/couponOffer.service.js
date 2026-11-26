import { z } from 'zod';
import CouponOffer from '../models/CouponOffer.js';
import CouponCategory from '../models/CouponCategory.js';
import Seller from '../models/Seller.js';
import SellerSubscription from '../models/SellerSubscription.js';
import { ApiError } from '../utils/ApiError.js';
import { logActivity } from './activityLog.service.js';
import { OFFER_STATUSES } from '../config/coupon.config.js';
import { COUPON_VALIDITY_DAYS } from '../config/coupon.config.js';

// Coupon categories (the super admin's on/off switches) and the offers sellers write — what a
// customer's coupon actually gives them. An offer reaches customers only once a super admin
// has approved it and while the seller keeps it running:
//
//   draft ──submit──→ pending_review ──approve──→ approved ──pause──→ paused ──resume──→ approved
//     ↑                     └──reject──→ rejected                 │
//     └──────── edit (rejected → draft) ──────┘                   │
//   edit while approved or paused → pending_review (the change must be reviewed again)
//
// Every transition is one conditional update on the expected status, so a seller's edit and an
// admin's approval racing each other can't both land; anything else is 409 INVALID_STATE.
// A seller only ever sees and changes its own offers: another seller's id answers 404.

// ── Validation ────────────────────────────────────────────────────────────────

const offerFields = {
  title: z.string().trim().min(3, 'Give the offer a short title').max(120),
  terms: z.string().trim().max(2000),
  validityDays: z.number().int('Whole days only').min(1).max(365).nullable(),
  // Who it is for (models/CouponOffer.js): gender, and an optional age range.
  targetGender: z.enum(['all', 'male', 'female'], { errorMap: () => ({ message: 'Choose who the offer is for' }) }),
  ageMin: z.number().int('Whole years only').min(10, 'Minimum age is 10').max(100).nullable(),
  ageMax: z.number().int('Whole years only').min(10).max(100, 'Maximum age is 100').nullable(),
};
const agesInOrder = (v) => v.ageMin == null || v.ageMax == null || v.ageMin <= v.ageMax;
const AGE_ORDER = { message: 'The minimum age must not be more than the maximum', path: ['ageMax'] };
export const createOfferSchema = z
  .object({
    ...offerFields,
    terms: offerFields.terms.optional(),
    validityDays: offerFields.validityDays.optional(),
    targetGender: offerFields.targetGender.optional(),
    ageMin: offerFields.ageMin.optional(),
    ageMax: offerFields.ageMax.optional(),
  })
  .strict()
  .refine(agesInOrder, AGE_ORDER);
export const updateOfferSchema = z
  .object(offerFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change')
  .refine(agesInOrder, AGE_ORDER);

// ── Views ─────────────────────────────────────────────────────────────────────

export const offerView = (o, { category = null, seller = null } = {}) => ({
  _id: o._id,
  title: o.title,
  terms: o.terms ?? '',
  // Fixed for every offer (COUPON_VALIDITY_DAYS); a value an older portal sent is ignored.
  validityDays: COUPON_VALIDITY_DAYS,
  targetGender: o.targetGender ?? 'all',
  ageMin: o.ageMin ?? null,
  ageMax: o.ageMax ?? null,
  status: o.status,
  rejectionReason: o.status === 'rejected' ? o.rejectionReason ?? null : null,
  categoryId: o.categoryId,
  ...(category ? { category: { _id: category._id, key: category.key, name: category.name } } : {}),
  ...(seller ? { seller: { _id: seller._id, businessName: seller.businessName, status: seller.status } } : {}),
  reviewedAt: o.reviewedAt ?? null,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

const INVALID = (status, action) =>
  new ApiError(409, 'INVALID_STATE', `A ${status.replace('_', ' ')} offer cannot be ${action}`, { status });

// Moves an offer `from` one of the given statuses with `set`, or explains why it couldn't.
const transition = async (filter, fromStatuses, set, action) => {
  const updated = await CouponOffer.findOneAndUpdate(
    { ...filter, status: { $in: fromStatuses } },
    { $set: set },
    { new: true, runValidators: true }
  ).lean();
  if (updated) return updated;
  const { updatedAt, ...identity } = filter;
  const current = await CouponOffer.findOne(identity).select('status updatedAt').lean();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Offer not found');
  if (updatedAt && current.updatedAt.getTime() !== updatedAt.getTime()) {
    throw new ApiError(409, 'OFFER_CHANGED', 'The seller changed this offer while you were reviewing it — reload and review it again');
  }
  throw INVALID(current.status, action);
};

// ── Seller ────────────────────────────────────────────────────────────────────

export const listSellerOffers = async (sellerId) => {
  const offers = await CouponOffer.find({ sellerId }).sort({ createdAt: -1 }).lean();
  return offers.map((o) => offerView(o));
};

/** A new offer, in the seller's own category, as a draft. */
export const createOffer = async (sellerId, userId, body) => {
  const seller = await Seller.findById(sellerId).select('categoryId').lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  const offer = await CouponOffer.create({
    sellerId,
    categoryId: seller.categoryId,
    title: body.title,
    terms: body.terms ?? '',
    validityDays: null, // fixed at COUPON_VALIDITY_DAYS — whatever was sent is ignored
    targetGender: body.targetGender ?? 'all',
    ageMin: body.ageMin ?? null,
    ageMax: body.ageMax ?? null,
    createdBy: userId,
  });
  return offerView(offer.toObject());
};

// Where an edit leaves the offer: drafts stay drafts, a rejected offer becomes a draft again,
// anything customers could already see goes back to review.
const STATUS_AFTER_EDIT = { draft: 'draft', rejected: 'draft', pending_review: 'pending_review', approved: 'pending_review', paused: 'pending_review' };

// An edit is always allowed, so it re-reads and retries when an admin decision lands between its
// read and its write (the status it was based on is then stale, and so is where the edit leaves it).
export const updateOffer = async (sellerId, offerId, rawPatch) => {
  // Validity is fixed (COUPON_VALIDITY_DAYS): a value sent by an older portal is dropped, and an
  // edit that only tried to change it changes nothing (it must not send a live offer to review).
  const { validityDays: _ignored, ...patch } = rawPatch;
  if (Object.keys(patch).length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to change');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await CouponOffer.findOne({ _id: offerId, sellerId }).lean();
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Offer not found');
    // A patch that changes only one end of the age range must still leave it in order.
    const ageMin = 'ageMin' in patch ? patch.ageMin : current.ageMin ?? null;
    const ageMax = 'ageMax' in patch ? patch.ageMax : current.ageMax ?? null;
    if (ageMin != null && ageMax != null && ageMin > ageMax) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'The minimum age must not be more than the maximum');
    }
    const next = STATUS_AFTER_EDIT[current.status];
    const set = { ...patch, status: next };
    if (next !== current.status) Object.assign(set, { rejectionReason: null, reviewedAt: null, reviewedBy: null });
    const updated = await CouponOffer.findOneAndUpdate(
      { _id: offerId, sellerId, status: current.status },
      { $set: set },
      { new: true, runValidators: true }
    ).lean();
    if (updated) return offerView(updated);
  }
  throw new ApiError(409, 'CONCURRENT_UPDATE', 'This offer was changed at the same time — please try again');
};

export const submitOffer = async (sellerId, offerId) =>
  offerView(await transition({ _id: offerId, sellerId }, ['draft', 'rejected'], { status: 'pending_review', rejectionReason: null }, 'submitted'));

export const pauseOffer = async (sellerId, offerId) =>
  offerView(await transition({ _id: offerId, sellerId }, ['approved'], { status: 'paused' }, 'paused'));

// Resuming needs no review: the offer is exactly what was approved (an edit would have sent it
// back to review instead of leaving it paused).
export const resumeOffer = async (sellerId, offerId) =>
  offerView(await transition({ _id: offerId, sellerId }, ['paused'], { status: 'approved' }, 'resumed'));

// ── Admin: offers ─────────────────────────────────────────────────────────────

export const adminListOffers = async ({ status, sellerId, categoryId, page = 1, limit = 20 }) => {
  const filter = {};
  if (status) filter.status = status;
  if (sellerId) filter.sellerId = sellerId;
  if (categoryId) filter.categoryId = categoryId;
  const [offers, total, counts] = await Promise.all([
    // Oldest first when reviewing — the queue is worked in the order it arrived.
    CouponOffer.find(filter)
      .sort(status === 'pending_review' ? { updatedAt: 1 } : { updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CouponOffer.countDocuments(filter),
    CouponOffer.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const [sellers, categories] = await Promise.all([
    Seller.find({ _id: { $in: offers.map((o) => o.sellerId) } }).select('businessName status').lean(),
    CouponCategory.find({ _id: { $in: offers.map((o) => o.categoryId) } }).select('key name').lean(),
  ]);
  const sellerById = new Map(sellers.map((s) => [String(s._id), s]));
  const categoryById = new Map(categories.map((c) => [String(c._id), c]));
  const statusCounts = Object.fromEntries(OFFER_STATUSES.map((s) => [s, 0]));
  for (const c of counts) statusCounts[c._id] = c.count;
  return {
    offers: offers.map((o) => offerView(o, { seller: sellerById.get(String(o.sellerId)), category: categoryById.get(String(o.categoryId)) })),
    total,
    page,
    pages: Math.ceil(total / limit),
    statusCounts,
  };
};

// `seenUpdatedAt` is the offer's updatedAt as the reviewing admin saw it. When given, a decision
// on an offer the seller changed since is refused (409 OFFER_CHANGED) — otherwise an edit landing
// a moment before the click would be approved without anyone having read it.
const reviewFilter = async (offerId, seenUpdatedAt) => {
  if (!seenUpdatedAt) return { _id: offerId };
  const current = await CouponOffer.findById(offerId).select('updatedAt').lean();
  if (current && current.updatedAt.getTime() !== new Date(seenUpdatedAt).getTime()) {
    throw new ApiError(409, 'OFFER_CHANGED', 'The seller changed this offer while you were reviewing it — reload and review it again');
  }
  return { _id: offerId, updatedAt: new Date(seenUpdatedAt) };
};

export const approveOffer = async (offerId, adminId, seenUpdatedAt = null) => {
  const offer = await transition(
    await reviewFilter(offerId, seenUpdatedAt),
    ['pending_review'],
    { status: 'approved', reviewedAt: new Date(), reviewedBy: adminId, rejectionReason: null },
    'approved'
  );
  await logActivity({ adminId, action: 'COUPON_OFFER_APPROVED', targetType: 'coupon_offer', targetId: offer._id, metadata: { sellerId: offer.sellerId } });
  return offerView(offer);
};

export const rejectOffer = async (offerId, adminId, reason, seenUpdatedAt = null) => {
  const offer = await transition(
    await reviewFilter(offerId, seenUpdatedAt),
    ['pending_review'],
    { status: 'rejected', reviewedAt: new Date(), reviewedBy: adminId, rejectionReason: reason },
    'rejected'
  );
  await logActivity({ adminId, action: 'COUPON_OFFER_REJECTED', targetType: 'coupon_offer', targetId: offer._id, metadata: { sellerId: offer.sellerId, reason } });
  return offerView(offer);
};

// ── Admin: categories ─────────────────────────────────────────────────────────

export const categorySchema = z
  .object({
    key: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,30}$/, 'Use 2–30 lowercase letters, digits or dashes'),
    name: z.string().trim().min(2).max(40),
    icon: z.string().trim().max(200).nullable().optional(),
    sortOrder: z.number().int().min(-1000).max(1000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const categoryPatchSchema = categorySchema
  .omit({ key: true })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/**
 * Every category with what an admin needs before switching it on: how many approved sellers
 * are in it, how many of them have a live offer, and the customer-coupon stock they hold.
 */
export const adminListCategories = async () => {
  const categories = await CouponCategory.find().sort({ sortOrder: 1, name: 1 }).lean();
  const [sellers, offers] = await Promise.all([
    Seller.find({ status: 'active' }).select('categoryId').lean(),
    CouponOffer.find({ status: 'approved' }).distinct('sellerId'),
  ]);
  const withOffer = new Set(offers.map(String));
  const stock = await SellerSubscription.aggregate([
    { $match: { status: 'active', sellerId: { $in: sellers.map((s) => s._id) } } },
    { $group: { _id: '$sellerId', remaining: { $sum: '$remaining' } } },
  ]);
  const stockBySeller = new Map(stock.map((s) => [String(s._id), s.remaining]));

  return categories.map((c) => {
    const inCategory = sellers.filter((s) => String(s.categoryId) === String(c._id));
    return {
      _id: c._id,
      key: c.key,
      name: c.name,
      icon: c.icon ?? null,
      enabled: c.enabled,
      sortOrder: c.sortOrder,
      activeSellers: inCategory.length,
      sellersWithLiveOffer: inCategory.filter((s) => withOffer.has(String(s._id))).length,
      stockRemaining: inCategory.reduce((n, s) => n + (stockBySeller.get(String(s._id)) ?? 0), 0),
    };
  });
};

export const createCategory = async (adminId, body) => {
  let category;
  try {
    category = await CouponCategory.create({ ...body, enabled: body.enabled ?? false });
  } catch (err) {
    if (err?.code === 11000) throw new ApiError(409, 'DUPLICATE_KEY', 'A category with this key already exists');
    throw err;
  }
  await logActivity({ adminId, action: 'COUPON_CATEGORY_CREATED', targetType: 'coupon_category', targetId: category._id, metadata: { key: category.key, enabled: category.enabled } });
  return category.toObject();
};

export const updateCategory = async (adminId, id, patch) => {
  const before = await CouponCategory.findById(id).lean();
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  const after = await CouponCategory.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean();
  const changes = Object.keys(patch)
    .filter((k) => before[k] !== after[k])
    .map((field) => ({ field, from: before[field] ?? null, to: after[field] }));
  const toggled = changes.find((c) => c.field === 'enabled');
  await logActivity({
    adminId,
    action: toggled ? (after.enabled ? 'COUPON_CATEGORY_ENABLED' : 'COUPON_CATEGORY_DISABLED') : 'COUPON_CATEGORY_UPDATED',
    targetType: 'coupon_category',
    targetId: after._id,
    metadata: { key: after.key, changes },
  });
  return after;
};
