import { randomUUID } from 'crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redis as defaultRedis } from '../config/redis.js';
import { ApiError } from '../utils/ApiError.js';

// The revocation denylist's Redis. Tests swap in an in-memory stand-in (test-utils/fakeRedis.mjs).
let redis = defaultRedis;
export const __setAuthRedisForTests = (client) => {
  redis = client === undefined ? defaultRedis : client;
};

export const hashPassword = (plain) =>
  argon2.hash(plain, { type: argon2.argon2id });

export const verifyPassword = (hash, plain) =>
  argon2.verify(hash, plain);

export const generateTokens = (userId, role) => {
  const accessToken = jwt.sign(
    { userId, role, jti: randomUUID() },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES }
  );
  const refreshToken = jwt.sign(
    { userId },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES }
  );
  return { accessToken, refreshToken };
};

// A diner at a table (yulo_menu, live customer activity): a guest user's access token that also
// names the restaurant + table it was issued at, so their browsing and ordering show on the
// owner's live dashboard against that table. Long enough for one sitting; never refreshed —
// scanning the QR again issues a new one.
export const DINER_TOKEN_SECONDS = 6 * 60 * 60;

export const generateDinerToken = (userId, { restaurantId, tableId }) =>
  jwt.sign(
    { userId, role: 'guest', dineIn: { restaurantId: String(restaurantId), tableId: String(tableId) }, jti: randomUUID() },
    env.JWT_ACCESS_SECRET,
    { expiresIn: DINER_TOKEN_SECONDS }
  );

// A staff session is one working day: exactly 24 hours from the OTP login, never refreshed
// or extended, so every waiter and chef proves they still hold their phone at least daily.
// Fixed in code on purpose — it is a security rule, not a tunable.
export const STAFF_SESSION_SECONDS = 24 * 60 * 60;

// `sv` is the member's sessionVersion at sign-in (models/StaffMember.js); bumping it on the
// member ends every token issued before.
export const generateStaffToken = (staffId, role, restaurantId, sessionVersion = 0) =>
  jwt.sign(
    { staffId, role, restaurantId, sv: sessionVersion, jti: randomUUID() },
    env.JWT_STAFF_SECRET,
    { expiresIn: STAFF_SESSION_SECONDS }
  );

// Partner tokens are access+refresh (unlike staff's single token) because the mobile app needs
// long-lived sessions without repeating an OTP login. RN has no cookie jar (see the comment in
// Delivery-Partner/src/api/client.js), so unlike the customer/owner refresh token, the partner
// refresh token is returned in the JSON body for the client to store in SecureStore — it is
// never set as a cookie.
export const generatePartnerTokens = (partnerId) => {
  const accessToken = jwt.sign(
    { partnerId, jti: randomUUID() },
    env.JWT_PARTNER_SECRET,
    { expiresIn: env.JWT_PARTNER_ACCESS_EXPIRES }
  );
  const refreshToken = jwt.sign(
    { partnerId },
    env.JWT_PARTNER_SECRET,
    { expiresIn: env.JWT_PARTNER_REFRESH_EXPIRES }
  );
  return { accessToken, refreshToken };
};

export const generatePartnerAccessToken = (partnerId) =>
  jwt.sign({ partnerId, jti: randomUUID() }, env.JWT_PARTNER_SECRET, {
    expiresIn: env.JWT_PARTNER_ACCESS_EXPIRES,
  });

// Which Redis key revokes a given token.
//
// This used to be the token string itself, which quietly made logout able to revoke a
// LATER session: jwt.sign is deterministic, so the same payload signed twice within one
// `iat` second produces byte-identical tokens, and an owner who signed out and straight
// back in got handed the very string logout had just denylisted — every call answering
// 401 "Token has been revoked" against a token they had only just been issued.
//
// The per-mint `jti` above makes each token distinct, so a revocation lands on exactly the
// one session it was meant for. Tokens minted before `jti` existed don't carry one and
// fall back to the old key, so nothing already in flight is let through by this change.
const revocationKey = (decoded, token) => `blacklist:${decoded?.jti ?? token}`;

export const blacklistToken = async (token) => {
  const decoded = jwt.decode(token);
  if (!decoded?.exp) return;
  const ttl = decoded.exp - Math.floor(Date.now() / 1000);
  // No Redis configured (REDIS_URL unset, which config/env.js allows): there is no denylist
  // to write to. Logout still clears the client's tokens; it just can't revoke this one early.
  if (!redis) return;
  if (ttl > 0) await redis.set(revocationKey(decoded, token), '1', 'EX', ttl);
};

// Callers must verify the token first — the `jti` this keys off is only trustworthy once
// the signature has been checked, and there is no reason to ask Redis about a forgery.
//
// With no Redis configured nothing can have been revoked, so the answer is "no" — the
// behaviour the README always described. Before this guard, every authenticated request
// crashed with a TypeError when REDIS_URL was unset.
export const isTokenRevoked = async (decoded, token) =>
  redis ? (await redis.get(revocationKey(decoded, token))) !== null : false;

// ── Seller (coupon partner) portal sessions ──────────────────────────────────
//
// Access + refresh, both signed with JWT_SELLER_SECRET and told apart by `typ`, so a refresh
// token can never be used as an access token or the other way round. Both carry the user's
// sessionVersion (`sv`, models/SellerUser.js): bumping it — deactivation, a role change, the
// seller being suspended — ends the session at its next request AND its next refresh. The web
// portal keeps the refresh token in its own httpOnly cookie (utils/refreshCookie.js, 'seller').
//
// A third, short-lived kind, `typ: 'signup'`, proves a phone number passed OTP when no seller
// login exists for it yet; seller signup (CB3) accepts it instead of a second OTP. A fourth,
// `typ: 'select'`, does the same for a number with logins at several sellers, so the person
// can pick one without another OTP.

export const SELLER_TOKEN_TYPES = Object.freeze({ access: 'access', refresh: 'refresh', signup: 'signup', select: 'select' });
export const SELLER_PROOF_SECONDS = 15 * 60;

const sellerSecret = () => {
  if (!env.JWT_SELLER_SECRET) {
    throw new ApiError(503, 'SELLER_AUTH_NOT_CONFIGURED', 'Seller sign-in is not available on this server yet');
  }
  return env.JWT_SELLER_SECRET;
};

export const generateSellerTokens = (sellerUser) => {
  const base = { sellerUserId: String(sellerUser._id), sv: sellerUser.sessionVersion ?? 0 };
  const accessToken = jwt.sign(
    {
      ...base,
      sellerId: String(sellerUser.sellerId),
      role: sellerUser.role,
      typ: SELLER_TOKEN_TYPES.access,
      jti: randomUUID(),
    },
    sellerSecret(),
    { expiresIn: env.SELLER_ACCESS_EXPIRES }
  );
  const refreshToken = jwt.sign({ ...base, typ: SELLER_TOKEN_TYPES.refresh, jti: randomUUID() }, sellerSecret(), {
    expiresIn: env.SELLER_REFRESH_EXPIRES,
  });
  return { accessToken, refreshToken };
};

/** A short-lived proof that `phone` passed OTP (or a password) — see the note above. */
export const generateSellerProofToken = (typ, phone, extra = {}) =>
  jwt.sign({ typ, phone, ...extra, jti: randomUUID() }, sellerSecret(), { expiresIn: SELLER_PROOF_SECONDS });

/**
 * Verifies a seller token of the expected `typ`. Throws the same 401 the other auth paths use
 * for anything wrong with it — bad signature, expired, revoked, or the wrong kind of token.
 */
export const verifySellerToken = async (token, typ) => {
  let decoded;
  try {
    decoded = jwt.verify(token, sellerSecret());
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(401, 'INVALID_TOKEN', err?.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token');
  }
  if (decoded.typ !== typ) throw new ApiError(401, 'INVALID_TOKEN', 'Invalid token');
  if (await isTokenRevoked(decoded, token)) throw new ApiError(401, 'INVALID_TOKEN', 'Token has been revoked');
  return decoded;
};
