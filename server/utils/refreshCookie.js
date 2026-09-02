import { env } from '../config/env.js';

// One refresh cookie per portal.
//
// Cookies are scoped by host and ignore the port, so every portal on one machine
// shares a single jar: the owner portal and the customer QR app run on
// localhost:5173 and the super admin on localhost:5174. While all three wrote a
// cookie literally named `refreshToken`, whichever portal signed in last
// overwrote the others — a customer signing in on the QR app turned the owner's
// next POST /auth/refresh into a customer token — and whichever signed out first
// deleted the cookie for all of them, logging the rest out on their next reload.
//
// Naming them apart keeps the three sessions independent. Which one a refresh
// reads is decided by the `portal` the caller asks for, never by guessing.

export const PORTAL_COOKIES = {
  owner: 'yulo_rt_owner',
  customer: 'yulo_rt_customer',
  admin: 'yulo_rt_admin',
};

// Sessions minted before this change carry the old shared name. Honour it as a
// fallback so nobody is signed out by the deploy; it expires within 7 days.
const LEGACY_COOKIE = 'refreshToken';

const ROLE_PORTALS = {
  restaurant_owner: 'owner',
  customer: 'customer',
  admin: 'admin',
};

export function portalForRole(role) {
  return ROLE_PORTALS[role] ?? null;
}

export function isPortal(portal) {
  return Object.hasOwn(PORTAL_COOKIES, portal);
}

// SameSite=None is the only setting a browser will send to an API on a different
// site than the page (frontend and API on unrelated domains), and it requires
// Secure. Lax covers the common cases — dev on localhost ports, and a production
// deploy where app and API share a registrable domain — without opening the
// cookie up to every cross-site request.
function cookieOptions() {
  const sameSite = env.REFRESH_COOKIE_SAMESITE;
  return {
    httpOnly: true,
    secure: sameSite === 'none' || env.NODE_ENV === 'production',
    sameSite,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

export function setRefreshCookie(res, role, token) {
  const portal = portalForRole(role);
  if (!portal) return;
  res.cookie(PORTAL_COOKIES[portal], token, cookieOptions());
}

export function clearRefreshCookie(res, portal) {
  if (!isPortal(portal)) return;
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(PORTAL_COOKIES[portal], opts);
  // Old shared cookie, if this browser still has one.
  res.clearCookie(LEGACY_COOKIE, opts);
}

export function readRefreshToken(req, portal) {
  const cookies = req.cookies ?? {};
  if (isPortal(portal) && cookies[PORTAL_COOKIES[portal]]) {
    return cookies[PORTAL_COOKIES[portal]];
  }
  return cookies[LEGACY_COOKIE] ?? null;
}
