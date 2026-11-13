import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';
import { RATE_LIMITS } from '../config/liveActivity.config.js';

// CORS preflights carry no credentials and do no work — counting them would
// halve every real budget below.
const skipPreflight = (req) => req.method === 'OPTIONS';

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many login attempts' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// Guest creation needs no input at all — no OTP, no password, nothing to get wrong —
// which makes it the cheapest thing on the whole API to automate. It used to share
// authLimiter with signup/login/OTP; a script hammering it would burn that 10/min
// budget and lock real users on the same IP out of logging in too. Its own, tighter
// budget keeps guest spam from ever touching real auth attempts.
export const guestLoginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many guest sessions started — please wait a moment' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// A single owner-dashboard load fans out to ~15-25 endpoints (and React's
// StrictMode doubles that in development), so the old 100/min budget was spent
// by the fourth page refresh — every screen then 429'd, POST /auth/refresh with
// it, and the portal signed the owner out. Keep a ceiling against abuse, but set
// it above what the app legitimately needs.
// Staff OTP send/verify. Looser than authLimiter on purpose: a whole shift signs in from the
// restaurant's one Wi-Fi address at opening time (each member needs a send and a verify),
// and authLimiter's 10/min would lock half the floor out. Guessing is already capped per
// code (5 tries) and per number (3 codes / 10 min) in services/otp.service.js.
export const staffOtpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many login attempts. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// Seller portal sign-in (OTP send/verify, password login, account pick). Sized like the staff
// limiter: a shop's whole team signs in from one Wi-Fi address at opening time. Guessing is
// capped per code and per number in services/otp.service.js. Keyed explicitly by IP (the same
// key the default uses) so tests can reset it with sellerAuthLimiterKey().
export const sellerAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  // ipKeyGenerator inline: the library inspects this function's source to check IPv6 addresses
  // are grouped by subnet, and warns when it can't see the call.
  keyGenerator: (req) => `seller-auth:${ipKeyGenerator(req.ip ?? '')}`,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

/** The seller sign-in limiter's key for an IP. */
export function sellerAuthLimiterKey(ip) {
  return `seller-auth:${ipKeyGenerator(ip ?? '')}`;
}

// Coupon redemption at a seller's counter (CB7): lookup + redeem, per seller LOGIN (it runs after
// authenticateSeller), so one counter can't hammer codes while the rest of the shop keeps working.
// Repeated wrong codes are also locked out separately (services/couponRedeem.service.js).
export const SELLER_REDEEM_LIMIT = 30;
export const sellerRedeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: SELLER_REDEEM_LIMIT,
  keyGenerator: (req) => sellerRedeemLimiterKey(req.seller?.userId),
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many coupon checks. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

/** The redemption limiter's key for a seller user. */
export function sellerRedeemLimiterKey(sellerUserId) {
  return `seller-redeem:${sellerUserId ?? 'anonymous'}`;
}

// Admin bulk exports (CB9 coupon CSV): each holds customer mobile numbers, so a few a minute per
// admin login — enough for real use, a brake on a scripted or stolen session pulling everything.
export const ADMIN_EXPORT_LIMIT = 5;
export const adminExportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: ADMIN_EXPORT_LIMIT,
  keyGenerator: (req) => `admin-export:${req.user?._id ?? 'anonymous'}`,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many exports. Please wait a minute and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// The guest QR-ordering endpoint is the most abuse-exposed route in the app: public, no
// JWT, and it writes an order straight to the kitchen. It still sits under the global
// apiLimiter above, but gets its own tighter per-IP budget on top — one prankster
// refreshing a checkout button shouldn't be able to flood a restaurant's kitchen queue.
// A diner token per table-QR scan (yulo_menu). Generous: a full restaurant shares one public IP.
export const dinerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many scans — please wait a moment' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

export const guestOrderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many orders placed — please wait a moment' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// Session refresh gets its own budget so a busy (or runaway) page can never cost
// the user their session: being rate limited out of /auth/refresh is
// indistinguishable, client-side, from having no session left. It is cheap —
// one cookie verify and one findById — and is only reachable with a valid
// httpOnly refresh cookie.
export const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many refresh attempts' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// Personal offers from the live dashboard: 20 a minute per RESTAURANT (not per IP — an owner's
// whole team shares one budget, and a stolen token can't spam past it from many addresses).
// A preview saves nothing and counts toward nothing, this budget included.
export const liveOfferLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMITS.offerCreatePerMinutePerRestaurant,
  keyGenerator: (req) => liveOfferLimiterKey(req.params.restaurantId),
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many offers sent — please wait a minute' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => skipPreflight(req) || req.body?.preview === true,
});

/** The limiter's key for a restaurant (tests reset it with `liveOfferLimiter.resetKey`). */
export function liveOfferLimiterKey(restaurantId) {
  return `liveoffer:${restaurantId}`;
}
