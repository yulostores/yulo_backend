// CB11 — the access matrix for every coupon route. One table lists each route under /api/seller,
// /api/admin/coupon*, /api/admin/sellers, /api/admin/reminder-campaigns and /api/users/me/coupons
// with the roles allowed to call it; for each route:
//   no token                → 401
//   each role not allowed   → 403 (same login system) — or 401 for a token from the OTHER system
//                             (a seller token on an admin route is not a valid admin token at all)
//   each allowed role       → anything but 401/403
//   an invalid body         → 400 VALIDATION_ERROR (the API's validation status — see API.md
//                             § Error Codes), for every route that takes a JSON body
// And the table must be complete: the test walks Express's router and fails on any mounted route
// in those prefixes that the table doesn't list (or a table row that no longer exists).
// In-memory MongoDB and Redis; Razorpay never called (no request here reaches it).

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

// Express 5 keeps no mount paths, so the routes are recorded as the app builds them.
const { installRouteRecorder, mountedRoutes: listRoutes, COUPON_ROUTE_SCOPE } = await import('../test-utils/routeRecorder.mjs');
const recorder = installRouteRecorder();
const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { app } = await import('../app.js');
recorder.uninstall();

const { makeCategory, makeCompleteSeller, sellerHeaders } = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const otp = await import('../services/otp.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: User } = await import('../models/User.js');

const mountedRoutes = () => listRoutes(app, COUPON_ROUTE_SCOPE);

// ── The table ─────────────────────────────────────────────────────────────────
// [method, path, allowed roles | 'public', invalid JSON body (or null when the route takes none)]
const OWN = ['owner'];
const OM = ['owner', 'manager'];
const ALL_SELLER = ['owner', 'manager', 'employee'];
const ADMIN = ['admin'];
const USER = ['customer', 'admin']; // any signed-in app account (an admin simply has no coupons)
const BAD = { __bogus: true };

const TABLE = [
  // Seller — sign-in (public: these are how you get a token)
  ['GET', '/api/seller/auth/categories', 'public', null],
  ['POST', '/api/seller/auth/signup', 'public', {}],
  ['POST', '/api/seller/auth/otp/send', 'public', {}],
  ['POST', '/api/seller/auth/otp/verify', 'public', {}],
  ['POST', '/api/seller/auth/select-account', 'public', {}],
  ['POST', '/api/seller/auth/login', 'public', {}],
  ['POST', '/api/seller/auth/refresh', 'refresh', null],
  ['GET', '/api/seller/auth/me', ALL_SELLER, null],
  ['POST', '/api/seller/auth/password', OWN, {}],
  ['POST', '/api/seller/auth/logout', ALL_SELLER, null],
  ['GET', '/api/seller/status', ALL_SELLER, null],
  // Onboarding (owner)
  ['GET', '/api/seller/onboarding', OWN, null],
  ['PUT', '/api/seller/onboarding/business', OWN, { businessPhone: '1' }],
  ['PUT', '/api/seller/onboarding/owner', OWN, {}],
  ['PUT', '/api/seller/onboarding/employees', OWN, {}],
  ['POST', '/api/seller/onboarding/submit', OWN, null],
  ['POST', '/api/seller/onboarding/documents', OWN, null], // multipart — covered in coupon-seller-onboarding
  ['GET', '/api/seller/onboarding/documents/:docId/file', OWN, null],
  ['DELETE', '/api/seller/onboarding/documents/:docId', OWN, null],
  // Plans
  ['GET', '/api/seller/plans', OM, null],
  ['GET', '/api/seller/subscriptions', OM, null],
  ['POST', '/api/seller/subscriptions', OWN, { planKey: 5 }],
  ['POST', '/api/seller/subscriptions/:id/verify', OWN, {}],
  ['POST', '/api/seller/subscriptions/:id/simulate-payment', OWN, null],
  // Offers
  ['GET', '/api/seller/offers', OM, null],
  ['POST', '/api/seller/offers', OM, {}],
  ['PATCH', '/api/seller/offers/:id', OM, { title: '' }],
  ['POST', '/api/seller/offers/:id/submit', OM, null],
  ['POST', '/api/seller/offers/:id/pause', OM, null],
  ['POST', '/api/seller/offers/:id/resume', OM, null],
  // Redemption (every role)
  ['POST', '/api/seller/redeem/lookup', ALL_SELLER, {}],
  ['POST', '/api/seller/redeem', ALL_SELLER, { code: 'X', phoneLast4: 'abcd' }],
  ['GET', '/api/seller/redeem/today', ALL_SELLER, null],
  // Dashboard, reports, team, profile, agreement
  ['GET', '/api/seller/dashboard', OM, null],
  ['GET', '/api/seller/reports/demographics', OM, null],
  ['GET', '/api/seller/reports/trends', OM, null],
  ['GET', '/api/seller/reports/coupons', OM, null],
  ['GET', '/api/seller/reports/coupons.csv', OM, null],
  ['GET', '/api/seller/users', OM, null],
  ['POST', '/api/seller/users', OM, {}],
  ['PATCH', '/api/seller/users/:id', OM, {}],
  ['DELETE', '/api/seller/users/:id', OM, null],
  ['GET', '/api/seller/profile', OM, null],
  ['PATCH', '/api/seller/profile', OWN, { businessPhone: '1' }],
  ['GET', '/api/seller/agreement', OM, null],
  ['POST', '/api/seller/agreement/accept', OWN, { version: 'one' }],
  // SMS credits and reminders
  ['GET', '/api/seller/sms-credits', OM, null],
  ['POST', '/api/seller/sms-credits/purchase', OM, { credits: 'x' }],
  ['POST', '/api/seller/sms-credits/purchase/:id/verify', OM, {}],
  ['POST', '/api/seller/sms-credits/purchase/:id/simulate-payment', OM, null],
  ['GET', '/api/seller/reminders', OM, null],

  // Admin — sellers
  ['GET', '/api/admin/sellers', ADMIN, null],
  ['GET', '/api/admin/sellers/:id', ADMIN, null],
  ['GET', '/api/admin/sellers/:id/users', ADMIN, null],
  ['POST', '/api/admin/sellers/:id/reveal', ADMIN, BAD],
  ['PATCH', '/api/admin/sellers/:id/approve', ADMIN, null],
  ['PATCH', '/api/admin/sellers/:id/reject', ADMIN, BAD],
  ['PATCH', '/api/admin/sellers/:id/suspend', ADMIN, BAD],
  ['PATCH', '/api/admin/sellers/:id/reactivate', ADMIN, null],
  ['GET', '/api/admin/sellers/:id/documents/:docId/file', ADMIN, null],
  ['GET', '/api/admin/sellers/:id/subscriptions', ADMIN, null],
  ['POST', '/api/admin/sellers/:id/subscriptions/manual', ADMIN, BAD],
  ['POST', '/api/admin/sellers/:id/sms-credits/manual', ADMIN, BAD],
  // Admin — plans, categories, offers
  ['GET', '/api/admin/coupon-plans', ADMIN, null],
  ['PUT', '/api/admin/coupon-plans/:key', ADMIN, BAD],
  ['GET', '/api/admin/coupon-categories', ADMIN, null],
  ['POST', '/api/admin/coupon-categories', ADMIN, {}],
  ['PATCH', '/api/admin/coupon-categories/:id', ADMIN, BAD],
  ['GET', '/api/admin/coupon-offers', ADMIN, null],
  ['PATCH', '/api/admin/coupon-offers/:id/approve', ADMIN, { updatedAt: 'yesterday' }],
  ['PATCH', '/api/admin/coupon-offers/:id/reject', ADMIN, {}],
  // Admin — coupons
  ['GET', '/api/admin/coupons', ADMIN, null],
  ['GET', '/api/admin/coupons/export.csv', ADMIN, null],
  ['GET', '/api/admin/coupons/complimentary', ADMIN, null],
  ['PATCH', '/api/admin/coupons/complimentary/:id/assign', ADMIN, {}],
  ['PATCH', '/api/admin/coupons/complimentary/:id/mark-used', ADMIN, null],
  ['POST', '/api/admin/coupons/issue', ADMIN, {}],
  // Admin — reports and settings
  ['GET', '/api/admin/coupon-reports/summary', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/by-category', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/by-seller', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/demographics', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/trends', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/employees', ADMIN, null],
  ['GET', '/api/admin/coupon-reports/sellers', ADMIN, null],
  ['GET', '/api/admin/coupon-settings', ADMIN, null],
  ['PUT', '/api/admin/coupon-settings', ADMIN, BAD],
  // Admin — reminder campaigns
  ['POST', '/api/admin/reminder-campaigns/preview', ADMIN, BAD],
  ['POST', '/api/admin/reminder-campaigns', ADMIN, BAD],
  ['GET', '/api/admin/reminder-campaigns', ADMIN, null],
  ['GET', '/api/admin/reminder-campaigns/:id', ADMIN, null],

  // Customer
  ['GET', '/api/users/me/coupons', USER, null],
  ['GET', '/api/users/me/coupons/:id', USER, null],
];

const SELLER_ROLES = ['owner', 'manager', 'employee'];
const USER_ROLES = ['customer', 'admin'];
const ROLES = [...USER_ROLES, ...SELLER_ROLES];

// ── Fixture ───────────────────────────────────────────────────────────────────

const redis = fakeRedis();
let mongo;
let srv;
let people; // role → SellerUser / User row
let params;
let pendingOwner;

before(async () => {
  mongo = await startMemoryMongo();
  await SellerUser.init();
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  redemption.__setRedeemRedisForTests(redis);
  srv = await startTestServer();
  const category = await makeCategory({ key: 'salon', name: 'Salon', enabled: true });
  const shop = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000001' });
  people = {
    owner: shop.owner,
    manager: await SellerUser.create({ sellerId: shop.seller._id, name: 'Meera Nair', phone: '9700000001', role: 'manager' }),
    employee: await SellerUser.create({ sellerId: shop.seller._id, name: 'Ravi Kumar', phone: '9700000002', role: 'employee' }),
    customer: await User.create({ name: 'Priya', phone: '9811100001', role: 'customer' }),
    admin: await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' }),
  };
  // Onboarding is edited while an application is pending (an approved one is locked, 409), so the
  // onboarding rows are exercised as a pending seller's owner.
  pendingOwner = (await makeCompleteSeller({ status: 'pending', submitted: false, categoryId: category._id, phone: '9600000002' })).owner;
  const fakeId = String(new mongoose.Types.ObjectId());
  params = { ':id': fakeId, ':docId': fakeId, ':key': 'basic' };
});
after(async () => {
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  redemption.__setRedeemRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

// A fresh token per request, so a logout or a revoked token in one row never affects another.
const headersFor = (role, path = '') => {
  if (role === 'owner' && path.startsWith('/api/seller/onboarding')) return sellerHeaders(pendingOwner);
  if (SELLER_ROLES.includes(role)) return sellerHeaders(people[role]);
  return { authorization: `Bearer ${auth.generateTokens(people[role]._id, role).accessToken}` };
};
const realm = (role) => (SELLER_ROLES.includes(role) ? 'seller' : 'user');
const routeRealm = (path) => (path.startsWith('/api/seller') ? 'seller' : 'user');
const fill = (path) => path.replace(/:\w+/g, (p) => params[p]);
const call = (method, path, { headers = {}, body } = {}) =>
  srv.request(method, fill(path), { headers, body: body ?? (['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined) });

// ── Tests ─────────────────────────────────────────────────────────────────────

test('the table lists every mounted coupon route, and nothing that is not mounted', () => {
  const mounted = new Set(mountedRoutes());
  const listed = new Set(TABLE.map(([m, p]) => `${m} ${p}`));
  assert.ok(mounted.size >= 90, `router walk found only ${mounted.size} routes — is the recorder broken?`);
  const missing = [...mounted].filter((r) => !listed.has(r));
  const stale = [...listed].filter((r) => !mounted.has(r));
  assert.deepEqual(missing, [], `mounted but not in the matrix table:\n${missing.join('\n')}`);
  assert.deepEqual(stale, [], `in the table but not mounted:\n${stale.join('\n')}`);
  assert.equal(listed.size, TABLE.length, 'no duplicate rows');
});

test('no token → 401 on every protected route; public routes never ask for one', async () => {
  for (const [method, path, roles] of TABLE) {
    const res = await call(method, path);
    if (roles === 'public') assert.ok(![401, 403].includes(res.status), `${method} ${path} public, got ${res.status}`);
    else assert.equal(res.status, 401, `${method} ${path} without a token: ${res.status} ${JSON.stringify(res.body)}`);
  }
});

test('every role not allowed → 403 (401 for a token from the other login system)', async () => {
  for (const [method, path, roles] of TABLE) {
    if (!Array.isArray(roles)) continue;
    for (const role of ROLES.filter((r) => !roles.includes(r))) {
      const res = await call(method, path, { headers: headersFor(role) });
      if (realm(role) === routeRealm(path)) {
        assert.equal(res.status, 403, `${role} ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      } else {
        assert.ok([401, 403].includes(res.status), `${role} ${method} ${path} (other realm): ${res.status}`);
      }
    }
  }
});

test('every allowed role gets through (not 401/403); an invalid body is a 400 VALIDATION_ERROR', async () => {
  for (const [method, path, roles, invalid] of TABLE) {
    if (!Array.isArray(roles)) continue;
    for (const role of roles) {
      const res = await call(method, path, { headers: headersFor(role, path), body: invalid ?? undefined });
      assert.ok(![401, 403].includes(res.status), `${role} ${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      if (invalid) {
        assert.equal(res.status, 400, `${role} ${method} ${path} with ${JSON.stringify(invalid)}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.code, 'VALIDATION_ERROR', `${role} ${method} ${path}: ${res.body.code}`);
      }
    }
  }
});

test('public routes with a body reject an invalid one with 400 VALIDATION_ERROR', async () => {
  for (const [method, path, roles, invalid] of TABLE) {
    if (roles !== 'public' || !invalid) continue;
    const res = await call(method, path, { body: invalid });
    assert.equal(res.status, 400, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  // Refresh without its cookie is a plain 401 — there is nothing to refresh.
  assert.equal((await call('POST', '/api/seller/auth/refresh')).status, 401);
});
