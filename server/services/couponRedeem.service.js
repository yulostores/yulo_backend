import crypto from 'crypto';
import mongoose from 'mongoose';
import Coupon from '../models/Coupon.js';
import User from '../models/User.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import { redis as defaultRedis } from '../config/redis.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { normalizeCouponCode } from '../utils/couponCode.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// Coupon redemption at the seller's counter (COUPON_IMPLEMENTATION_PROMPTS.md § CB7).
//
// A coupon is redeemed by ONE conditional update — { code, sellerId, kind: 'customer',
// status: 'issued', expiresAt > now } → redeemed — so twenty taps of "Redeem" (or two counters at
// once) redeem it exactly once. Only when that update matches nothing do we look at the coupon
// again to say why.
//
// What a seller can learn: a code that is not theirs answers exactly like a code that doesn't
// exist (404, same body), and so does a complimentary coupon. The customer appears as a first
// name only — never their phone or account id. The optional phone check compares the last 4
// digits on the server and only ever answers "matches" or "doesn't".
//
// Guessing: every not-found code and every wrong phone check counts against the seller user (and
// the seller as a whole); too many in the window locks redemption for a while (429
// REDEEM_LOCKED). Counted in Redis when it is up, so every server instance shares the count;
// otherwise in this process.

const NOT_FOUND_MESSAGE = 'No coupon with this code for your business';
const notFound = () => new ApiError(404, 'COUPON_NOT_FOUND', NOT_FOUND_MESSAGE);

// ── Lockout ───────────────────────────────────────────────────────────────────

export const REDEEM_LOCKOUT = Object.freeze({
  windowSeconds: 15 * 60,
  perUser: 10, // wrong codes / phone checks by one login in the window
  perSeller: 25, // across all of a seller's logins (several staff guessing together)
});

let redisOverride; // undefined → the real client; null → none (in-process); object → a test double
export const __setRedeemRedisForTests = (client) => {
  redisOverride = client;
  memory.clear();
};
const liveRedis = () => {
  if (redisOverride !== undefined) return redisOverride;
  return defaultRedis?.status === 'ready' ? defaultRedis : null;
};

// In-process fallback: key → { count, resetAt }.
const memory = new Map();

const failureKeys = ({ sellerId, userId }) => [
  [`coupon-redeem:fail:user:${userId}`, REDEEM_LOCKOUT.perUser],
  [`coupon-redeem:fail:seller:${sellerId}`, REDEEM_LOCKOUT.perSeller],
];

const readCount = async (key) => {
  const r = liveRedis();
  if (r) {
    try {
      return Number((await r.get(key)) ?? 0);
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'Redeem lockout: Redis read failed, using this process');
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return entry.count;
};

const bump = async (key) => {
  const r = liveRedis();
  if (r) {
    try {
      const n = await r.incr(key);
      if (n === 1) await r.expire(key, REDEEM_LOCKOUT.windowSeconds);
      return;
    } catch (err) {
      logger.warn({ err: { message: err?.message } }, 'Redeem lockout: Redis write failed, using this process');
    }
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) memory.set(key, { count: 1, resetAt: now + REDEEM_LOCKOUT.windowSeconds * 1000 });
  else entry.count += 1;
};

const assertNotLocked = async (who) => {
  for (const [key, max] of failureKeys(who)) {
    if ((await readCount(key)) >= max) {
      throw new ApiError(429, 'REDEEM_LOCKED', 'Too many wrong codes. Redemption is paused for 15 minutes — please check the code with the customer.');
    }
  }
};

const recordFailure = async (who) => {
  for (const [key] of failureKeys(who)) await bump(key);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const firstName = (name) => (typeof name === 'string' && name.trim() ? name.trim().split(/\s+/)[0] : null);

const last4Of = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

const sameDigits = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const scopeFilter = (sellerId, code) => ({ code, sellerId: new mongoose.Types.ObjectId(String(sellerId)), kind: 'customer' });

/** The coupon at this seller's counter, or a 404 (counted) for a code that isn't theirs. */
const findOwn = async (who, rawCode) => {
  const code = normalizeCouponCode(rawCode);
  const coupon = code
    ? await Coupon.findOne(scopeFilter(who.sellerId, code))
        .select('code categoryId offerId offerSnapshot customerId customerSnapshot status issuedAt expiresAt redeemedAt redeemedBy voidedAt')
        .lean()
    : null;
  if (!coupon) {
    await recordFailure(who);
    throw notFound();
  }
  return coupon;
};

const effectiveStatus = (coupon, now = new Date()) =>
  coupon.status === 'issued' && coupon.expiresAt <= now ? 'expired' : coupon.status;

const redeemerName = async (redeemedBy) =>
  redeemedBy ? ((await SellerUser.findById(redeemedBy).select('name').lean())?.name ?? null) : null;

/** Whether a phone check applies to this coupon: the setting is on and the customer has a phone. */
const customerLast4 = async (coupon) => {
  if (!coupon.customerId) return null;
  const user = await User.findById(coupon.customerId).select('phone').lean();
  return last4Of(user?.phone);
};

// The seller-safe view: no phone, no customer id, no subscription or source.
const counterView = async (coupon, { needsPhoneCheck }) => {
  const category = await CouponCategory.findById(coupon.categoryId).select('name').lean();
  const status = effectiveStatus(coupon);
  return {
    code: coupon.code,
    offerTitle: coupon.offerSnapshot?.title ?? null,
    terms: coupon.offerSnapshot?.terms ?? '',
    category: category?.name ?? null,
    customerFirstName: firstName(coupon.customerSnapshot?.name),
    issuedAt: coupon.issuedAt,
    expiresAt: coupon.expiresAt,
    status,
    needsPhoneCheck: status === 'issued' && needsPhoneCheck,
    ...(status === 'redeemed' ? { redeemedAt: coupon.redeemedAt, redeemedByName: await redeemerName(coupon.redeemedBy) } : {}),
  };
};

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * POST /api/seller/redeem/lookup — what the counter sees before redeeming.
 * @param {{ sellerId, userId, code }} args
 */
export const lookup = async ({ sellerId, userId, code }) => {
  const who = { sellerId, userId };
  await assertNotLocked(who);
  const coupon = await findOwn(who, code);
  const settings = await getActiveCouponSettings();
  const needsPhoneCheck = Boolean(settings.phoneCheckRequired) && (await customerLast4(coupon)) !== null;
  return counterView(coupon, { needsPhoneCheck });
};

// ── Redeem ────────────────────────────────────────────────────────────────────

/**
 * POST /api/seller/redeem. Exactly-once: a single conditional update. Errors:
 *   404 COUPON_NOT_FOUND          not this seller's (or complimentary, or no such code)
 *   409 COUPON_ALREADY_REDEEMED   { redeemedAt, redeemedByName }
 *   410 COUPON_EXPIRED            { expiresAt }
 *   409 COUPON_VOID               the order it came from was refunded
 *   422 PHONE_CHECK_REQUIRED      the setting is on and no digits were sent
 *   422 PHONE_MISMATCH            the digits don't match (nothing about the real number)
 *   429 REDEEM_LOCKED             too many wrong codes / digits
 */
export const redeem = async ({ sellerId, userId, code, phoneLast4 = null }) => {
  const who = { sellerId, userId };
  await assertNotLocked(who);
  const coupon = await findOwn(who, code);

  // Say why before checking digits: a redeemed / expired / void coupon can't be redeemed anyway.
  const explain = async (current) => {
    const status = effectiveStatus(current);
    if (status === 'redeemed') {
      return new ApiError(409, 'COUPON_ALREADY_REDEEMED', 'This coupon has already been redeemed', {
        redeemedAt: current.redeemedAt,
        redeemedByName: await redeemerName(current.redeemedBy),
      });
    }
    if (status === 'expired') return new ApiError(410, 'COUPON_EXPIRED', 'This coupon has expired', { expiresAt: current.expiresAt });
    if (status === 'void') return new ApiError(409, 'COUPON_VOID', 'This coupon is no longer valid — the order it came with was refunded');
    return null;
  };
  const early = await explain(coupon);
  if (early) throw early;

  const settings = await getActiveCouponSettings();
  const actual = await customerLast4(coupon);
  const given = typeof phoneLast4 === 'string' ? phoneLast4.trim() : null;
  if (actual !== null) {
    if (!given && settings.phoneCheckRequired) {
      throw new ApiError(422, 'PHONE_CHECK_REQUIRED', "Ask the customer for the last 4 digits of their phone number");
    }
    if (given && !sameDigits(given, actual)) {
      await recordFailure(who);
      throw new ApiError(422, 'PHONE_MISMATCH', "The digits don't match this coupon's customer");
    }
  }

  const now = new Date();
  const redeemed = await Coupon.findOneAndUpdate(
    { ...scopeFilter(sellerId, coupon.code), status: 'issued', expiresAt: { $gt: now } },
    { $set: { status: 'redeemed', redeemedAt: now, redeemedBy: userId } },
    { new: true }
  ).lean();

  if (!redeemed) {
    // Lost a race (someone else redeemed it a moment ago), or it expired / was voided meanwhile.
    const current = await Coupon.findOne(scopeFilter(sellerId, coupon.code)).lean();
    throw (current && (await explain(current))) ?? notFound();
  }

  const view = await counterView(redeemed, { needsPhoneCheck: false });
  return { ...view, redeemedAt: redeemed.redeemedAt, redeemedByName: await redeemerName(userId) };
};

// ── Today ─────────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60 * 1000;
/** Midnight today in India, as a UTC instant. */
export const startOfIstDay = (at = new Date()) => {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
};

/**
 * GET /api/seller/redeem/today — redemptions since midnight IST, newest first. An employee sees
 * their own; an owner or manager sees the whole business's, with who redeemed each.
 */
export const today = async ({ sellerId, userId, role }) => {
  const filter = {
    sellerId: new mongoose.Types.ObjectId(String(sellerId)),
    kind: 'customer',
    status: 'redeemed',
    redeemedAt: { $gte: startOfIstDay() },
  };
  if (role === 'employee') filter.redeemedBy = userId;
  const rows = await Coupon.find(filter)
    .sort({ redeemedAt: -1 })
    .limit(500)
    .select('code offerSnapshot customerSnapshot.name categoryId redeemedAt redeemedBy')
    .lean();
  const [users, categories] = await Promise.all([
    SellerUser.find({ _id: { $in: [...new Set(rows.map((r) => String(r.redeemedBy)))] } }).select('name').lean(),
    CouponCategory.find({ _id: { $in: [...new Set(rows.map((r) => String(r.categoryId)))] } }).select('name').lean(),
  ]);
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  const categoryName = new Map(categories.map((c) => [String(c._id), c.name]));
  return {
    scope: role === 'employee' ? 'mine' : 'business',
    count: rows.length,
    redemptions: rows.map((r) => ({
      code: r.code,
      offerTitle: r.offerSnapshot?.title ?? null,
      category: categoryName.get(String(r.categoryId)) ?? null,
      customerFirstName: firstName(r.customerSnapshot?.name),
      redeemedAt: r.redeemedAt,
      redeemedByName: userName.get(String(r.redeemedBy)) ?? null,
    })),
  };
};
