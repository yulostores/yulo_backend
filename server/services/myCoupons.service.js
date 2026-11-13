import mongoose from 'mongoose';
import Coupon from '../models/Coupon.js';
import Seller from '../models/Seller.js';
import CouponCategory from '../models/CouponCategory.js';
import CouponOffer from '../models/CouponOffer.js';
import { ApiError } from '../utils/ApiError.js';

// The customer's own coupons ("My Coupons" in the app) and the coupons an order/bill earned.
//
// Every query here is scoped to `kind: 'customer'` AND the customer's own id: a complimentary
// coupon (Yulo team only) or another customer's coupon can never be listed or opened, whatever
// id is asked for.

export const MY_COUPON_STATUSES = ['issued', 'redeemed', 'expired', 'void'];

// The expiry job (CB later) moves past-date coupons to 'expired' once a day; until it runs, an
// 'issued' coupon past its date is already expired for the customer.
const statusFilter = (status, now) => {
  if (status === 'issued') return { status: 'issued', expiresAt: { $gt: now } };
  if (status === 'expired') return { $or: [{ status: 'expired' }, { status: 'issued', expiresAt: { $lte: now } }] };
  if (status) return { status };
  return {};
};

const effectiveStatus = (coupon, now) => (coupon.status === 'issued' && coupon.expiresAt <= now ? 'expired' : coupon.status);

const addressLine = (a) => [a?.line1, a?.line2, a?.city, a?.state, a?.pincode].filter(Boolean).join(', ') || null;

const view = (coupon, { seller, category, offer }, now) => ({
  id: coupon._id,
  code: coupon.code,
  // What the app encodes in the QR the seller scans: the code itself, nothing else.
  qrPayload: coupon.code,
  title: coupon.offerSnapshot?.title ?? offer?.title ?? null,
  terms: coupon.offerSnapshot?.terms ?? offer?.terms ?? '',
  seller: seller
    ? {
        id: seller._id,
        name: seller.businessName,
        address: addressLine(seller.address),
        phone: seller.businessPhone ?? null,
        location: seller.location?.coordinates ? { longitude: seller.location.coordinates[0], latitude: seller.location.coordinates[1] } : null,
      }
    : null,
  category: category ? { id: category._id, key: category.key, name: category.name, icon: category.icon ?? null } : null,
  issuedAt: coupon.issuedAt,
  expiresAt: coupon.expiresAt,
  status: effectiveStatus(coupon, now),
  redeemedAt: coupon.redeemedAt ?? null,
  voidedAt: coupon.voidedAt ?? null,
  source: coupon.source?.type ? { type: coupon.source.type, id: coupon.source.id ?? null } : null,
});

const COUPON_FIELDS = 'code sellerId categoryId offerId offerSnapshot status issuedAt expiresAt redeemedAt voidedAt source';

const withRelations = async (coupons, now) => {
  const ids = (field) => [...new Set(coupons.map((c) => String(c[field])).filter((v) => v && v !== 'null'))];
  const [sellers, categories, offers] = await Promise.all([
    Seller.find({ _id: { $in: ids('sellerId') } }).select('businessName address businessPhone location').lean(),
    CouponCategory.find({ _id: { $in: ids('categoryId') } }).select('key name icon').lean(),
    CouponOffer.find({ _id: { $in: ids('offerId') } }).select('title terms').lean(),
  ]);
  const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const s = byId(sellers);
  const c = byId(categories);
  const o = byId(offers);
  return coupons.map((coupon) =>
    view(coupon, { seller: s.get(String(coupon.sellerId)), category: c.get(String(coupon.categoryId)), offer: o.get(String(coupon.offerId)) }, now)
  );
};

/** GET /api/users/me/coupons?status=&page=&limit= — newest first. */
export const listMyCoupons = async (customerId, { status = null, page = 1, limit = 20 } = {}) => {
  const now = new Date();
  const filter = { kind: 'customer', customerId, ...statusFilter(status, now) };
  const [rows, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ issuedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(COUPON_FIELDS)
      .lean(),
    Coupon.countDocuments(filter),
  ]);
  return { coupons: await withRelations(rows, now), total, page, limit };
};

/** GET /api/users/me/coupons/:id — 404 for anything that isn't this customer's own coupon. */
export const getMyCoupon = async (customerId, couponId) => {
  if (!mongoose.isValidObjectId(couponId)) throw new ApiError(404, 'NOT_FOUND', 'Coupon not found');
  const coupon = await Coupon.findOne({ _id: couponId, kind: 'customer', customerId }).select(COUPON_FIELDS).lean();
  if (!coupon) throw new ApiError(404, 'NOT_FOUND', 'Coupon not found');
  const [one] = await withRelations([coupon], new Date());
  return one;
};

/**
 * What an order / bill earned, for the payment success screens: { count, ids }. Voided coupons
 * (the payment was refunded) don't count. Issuing runs just after the payment, so a screen that
 * asks immediately may see 0 and should ask again a moment later.
 */
export const couponsEarned = async (sourceType, sourceId, customerId = null) => {
  const filter = { kind: 'customer', 'source.type': sourceType, 'source.id': sourceId, status: { $ne: 'void' } };
  if (customerId) filter.customerId = customerId;
  const rows = await Coupon.find(filter).sort({ issuedAt: 1, _id: 1 }).select('_id').lean();
  return { count: rows.length, ids: rows.map((r) => r._id) };
};
