import { randomUUID } from 'crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';

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

export const generateStaffToken = (staffId, role, restaurantId) =>
  jwt.sign({ staffId, role, restaurantId, jti: randomUUID() }, env.JWT_STAFF_SECRET, {
    expiresIn: env.JWT_STAFF_EXPIRES,
  });

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
  if (ttl > 0) await redis.set(revocationKey(decoded, token), '1', 'EX', ttl);
};

// Callers must verify the token first — the `jti` this keys off is only trustworthy once
// the signature has been checked, and there is no reason to ask Redis about a forgery.
export const isTokenRevoked = async (decoded, token) =>
  (await redis.get(revocationKey(decoded, token))) !== null;
