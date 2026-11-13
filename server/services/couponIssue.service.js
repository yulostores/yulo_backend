import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Seller from '../models/Seller.js';
import CouponCategory from '../models/CouponCategory.js';
import CouponOffer from '../models/CouponOffer.js';
import Coupon from '../models/Coupon.js';
import SellerSubscription from '../models/SellerSubscription.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { takeOne, giveBack } from './sellerSubscription.service.js';
import { generateCouponCode } from '../utils/couponCode.js';
import { toPaise } from '../utils/money.js';
import logger from '../utils/logger.js';
import { COUPON_VALIDITY_DAYS } from '../config/coupon.config.js';

// The issue engine: a customer's paid food order (or dine-in bill) earns coupons from coupon
// partners near the restaurant (COUPON_IMPLEMENTATION_PROMPTS.md § CB6).
//
// For each enabled category, in sortOrder, until CouponSettings.perOrderCap coupons are held:
//   candidates = active sellers in that category with an approved offer and stock left, within
//                radiusKm of the restaurant — nearest first, then the one that has issued fewest
//   → takeOne (atomic stock decrement) → insert the Coupon.
//
// Safe to run any number of times, concurrently, for the same payment: every coupon carries
// issueKey "<source>:<id>:<category>", which is unique, so the verify call and the webhook racing
// on one payment issue each category once. The loser of that race returns the stock it took.
//
// Never throws: a coupon problem must never fail or delay a customer's payment. Callers use
// scheduleIssue (fire-and-forget); failures are logged.

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const LIVE_REFUND = (refund) => refund?.status && refund.status !== 'none';

const isDuplicate = (err) => err?.code === 11000;
const duplicateOn = (err, field) => isDuplicate(err) && (err.keyPattern?.[field] || String(err.message ?? '').includes(`${field}_1`));

// ── The paying document ───────────────────────────────────────────────────────

/**
 * The order or bill a payment settled, reduced to what issuing needs, plus why it must NOT issue
 * (`skip`), or null when it doesn't exist.
 */
const loadSource = async (sourceType, sourceId) => {
  if (sourceType === 'order') {
    const order = await Order.findById(sourceId)
      .select('restaurantId userId status paymentStatus paymentChannel grandTotal subtotal paymentAmountPaise refund')
      .lean();
    if (!order) return null;
    let skip = null;
    if (order.paymentStatus !== 'paid') skip = 'not paid';
    else if (order.paymentChannel !== 'online') skip = 'not paid online';
    else if (order.status === 'cancelled') skip = 'cancelled';
    else if (LIVE_REFUND(order.refund)) skip = 'being refunded';
    return {
      restaurantId: order.restaurantId,
      customerId: order.userId ?? null,
      totalPaise: order.paymentAmountPaise ?? toPaise(order.grandTotal ?? order.subtotal ?? 0),
      skip,
    };
  }
  if (sourceType === 'bill') {
    const bill = await Bill.findById(sourceId).select('restaurantId customerId status paymentChannel grandTotal refund').lean();
    if (!bill) return null;
    let skip = null;
    if (bill.status !== 'paid') skip = 'not paid';
    else if (bill.paymentChannel !== 'online') skip = 'not paid online';
    else if (LIVE_REFUND(bill.refund)) skip = 'being refunded';
    return { restaurantId: bill.restaurantId, customerId: bill.customerId ?? null, totalPaise: toPaise(bill.grandTotal ?? 0), skip };
  }
  return null;
};

const validPoint = (location) =>
  Array.isArray(location?.coordinates) && location.coordinates.length === 2 && location.coordinates.every(Number.isFinite);

// ── Choosing a seller ─────────────────────────────────────────────────────────

/**
 * Sellers that can issue in `categoryId` near `coordinates`, best first: nearest, then fewest
 * coupons issued (so neighbours at the same spot take turns), then oldest. Each comes with its
 * approved offers.
 */
const candidateSellers = async ({ categoryId, coordinates, radiusKm }) => {
  const near = await Seller.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates },
        distanceField: 'distanceM',
        maxDistance: radiusKm * 1000,
        spherical: true,
        key: 'location',
        query: { status: 'active', categoryId: new mongoose.Types.ObjectId(String(categoryId)) },
      },
    },
    { $project: { _id: 1, distanceM: 1 } },
  ]);
  if (near.length === 0) return [];
  const ids = near.map((s) => s._id);

  const [offers, stock] = await Promise.all([
    CouponOffer.find({ sellerId: { $in: ids }, categoryId, status: 'approved' }).select('sellerId title terms validityDays').lean(),
    SellerSubscription.aggregate([
      { $match: { sellerId: { $in: ids }, status: { $in: ['active', 'exhausted'] } } },
      {
        $group: {
          _id: '$sellerId',
          issued: { $sum: '$issued' },
          remaining: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, '$remaining', 0] } },
        },
      },
    ]),
  ]);

  const offersBySeller = new Map();
  for (const offer of offers) {
    const key = String(offer.sellerId);
    if (!offersBySeller.has(key)) offersBySeller.set(key, []);
    offersBySeller.get(key).push(offer);
  }
  const stockBySeller = new Map(stock.map((s) => [String(s._id), s]));

  return near
    .map((s) => ({
      sellerId: s._id,
      distanceM: Math.round(s.distanceM),
      offers: offersBySeller.get(String(s._id)) ?? [],
      issued: stockBySeller.get(String(s._id))?.issued ?? 0,
      remaining: stockBySeller.get(String(s._id))?.remaining ?? 0,
    }))
    .filter((s) => s.offers.length > 0 && s.remaining > 0)
    .sort((a, b) => a.distanceM - b.distanceM || a.issued - b.issued || String(a.sellerId).localeCompare(String(b.sellerId)));
};

/** Of a seller's approved offers, the one handed out least (ties: the oldest), so they take turns. */
const pickOffer = async (offers) => {
  if (offers.length === 1) return offers[0];
  const counts = await Coupon.aggregate([
    { $match: { kind: 'customer', offerId: { $in: offers.map((o) => o._id) } } },
    { $group: { _id: '$offerId', n: { $sum: 1 } } },
  ]);
  const byOffer = new Map(counts.map((c) => [String(c._id), c.n]));
  return [...offers].sort((a, b) => (byOffer.get(String(a._id)) ?? 0) - (byOffer.get(String(b._id)) ?? 0) || String(a._id).localeCompare(String(b._id)))[0];
};

// ── Issuing one ───────────────────────────────────────────────────────────────

/**
 * Takes one unit of the seller's stock and writes the coupon. Returns the coupon, 'duplicate' when
 * this category was already issued for the source (stock given back), or null when the seller's
 * stock ran out between choosing and taking.
 */
const issueOne = async ({ candidate, category, sourceType, sourceId, customer, settings }) => {
  const subscription = await takeOne(candidate.sellerId);
  if (!subscription) return null;

  try {
    const offer = await pickOffer(candidate.offers);
    const now = new Date();
    const validityDays = COUPON_VALIDITY_DAYS; // fixed for every coupon
    const doc = {
      kind: 'customer',
      sellerId: candidate.sellerId,
      subscriptionId: subscription._id,
      offerId: offer._id,
      offerSnapshot: { title: offer.title, terms: offer.terms ?? '' },
      categoryId: category._id,
      customerId: customer._id,
      customerSnapshot: { name: customer.name || null, gender: customer.gender ?? null, dateOfBirth: customer.dateOfBirth ?? null },
      source: { type: sourceType, id: sourceId },
      issueKey: `${sourceType}:${sourceId}:${category._id}`,
      status: 'issued',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + validityDays * DAY_MS),
    };

    for (let attempt = 1; ; attempt += 1) {
      try {
        return (await Coupon.create({ ...doc, code: generateCouponCode() })).toObject();
      } catch (err) {
        if (duplicateOn(err, 'issueKey')) {
          await giveBack(subscription._id);
          return 'duplicate';
        }
        // A code collision (one in ~10^14): draw another.
        if (duplicateOn(err, 'code') && attempt < CODE_ATTEMPTS) continue;
        throw err;
      }
    }
  } catch (err) {
    await giveBack(subscription._id).catch((giveBackErr) =>
      logger.error({ err: giveBackErr, subscriptionId: subscription._id }, 'Coupon stock could not be returned after a failed issue')
    );
    throw err;
  }
};

/**
 * Issues the coupons a paid order / bill earns. Idempotent and race-safe (see top of file).
 * Returns the coupons THIS call created; never throws.
 *
 * @param {{ sourceType: 'order' | 'bill', sourceId: string }} args
 */
export const issueForPayment = async ({ sourceType, sourceId }) => {
  try {
    const source = await loadSource(sourceType, sourceId);
    if (!source || source.skip || !source.customerId) return [];

    const [settings, customer, restaurant] = await Promise.all([
      getActiveCouponSettings(),
      User.findById(source.customerId).select('name role isActive gender dateOfBirth').lean(),
      Restaurant.findById(source.restaurantId).select('location').lean(),
    ]);
    // A real customer account only — never a guest session or a staff/owner account.
    if (!customer || customer.role !== 'customer' || customer.isActive === false) return [];
    if (source.totalPaise < (settings.minOrderValuePaise ?? 0)) return [];
    if (!(settings.perOrderCap > 0)) return [];
    if (!validPoint(restaurant?.location)) {
      logger.warn({ sourceType, sourceId, restaurantId: source.restaurantId }, 'Coupons not issued: the restaurant has no location');
      return [];
    }

    const [categories, existing] = await Promise.all([
      CouponCategory.find({ enabled: true }).sort({ sortOrder: 1, _id: 1 }).lean(),
      Coupon.find({ kind: 'customer', 'source.type': sourceType, 'source.id': sourceId }).select('categoryId').lean(),
    ]);
    const held = new Set(existing.map((c) => String(c.categoryId)));
    const created = [];

    for (const category of categories) {
      if (held.size >= settings.perOrderCap) break;
      if (held.has(String(category._id))) continue;
      try {
        const candidates = await candidateSellers({
          categoryId: category._id,
          coordinates: restaurant.location.coordinates,
          radiusKm: settings.radiusKm,
        });
        for (const candidate of candidates) {
          const result = await issueOne({ candidate, category, sourceType, sourceId, customer, settings });
          if (result === null) continue; // that seller's stock just ran out — try the next
          held.add(String(category._id));
          if (result !== 'duplicate') created.push(result);
          break;
        }
      } catch (err) {
        // One category failing must not cost the customer the others.
        logger.error({ err, sourceType, sourceId, categoryId: category._id }, 'Coupon issue failed for a category');
      }
    }

    // A refund or cancellation that landed while we were issuing: take the coupons straight back.
    if (created.length) {
      const after = await loadSource(sourceType, sourceId);
      if (!after || after.skip) await voidForSource({ sourceType, sourceId, reason: 'Payment refunded or order cancelled' });
    }
    return created;
  } catch (err) {
    logger.error({ err, sourceType, sourceId }, 'Coupon issue failed');
    return [];
  }
};

// Fire-and-forget issuing, tracked so tests (and a graceful shutdown) can wait for it.
const inFlight = new Set();

/** Starts issuing for a paid order / bill without waiting for it. Never throws. */
export const scheduleIssue = (sourceType, sourceId) => {
  const task = Promise.resolve()
    .then(() => issueForPayment({ sourceType, sourceId }))
    .catch((err) => logger.error({ err, sourceType, sourceId }, 'Coupon issue failed'))
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
};

/** Resolves once every scheduled issue has finished. */
export const settleScheduledIssues = async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
};

// ── Voids ─────────────────────────────────────────────────────────────────────

/**
 * The paying order / bill was refunded: its unused coupons become void and each returns its unit
 * of stock. Each coupon is voided by a conditional update, so a repeat (two refund events) returns
 * stock once. Redeemed coupons are left alone. Returns how many were voided.
 */
export const voidForSource = async ({ sourceType, sourceId, reason = 'Payment refunded' }) => {
  const coupons = await Coupon.find({ kind: 'customer', 'source.type': sourceType, 'source.id': sourceId, status: 'issued' })
    .select('_id subscriptionId')
    .lean();
  let voided = 0;
  for (const coupon of coupons) {
    const res = await Coupon.updateOne(
      { _id: coupon._id, status: 'issued' },
      { $set: { status: 'void', voidedAt: new Date(), voidReason: reason } }
    );
    if (res.modifiedCount === 1) {
      voided += 1;
      await giveBack(coupon.subscriptionId);
    }
  }
  return voided;
};
