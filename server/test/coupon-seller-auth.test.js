// CB2 — seller (coupon partner) portal authentication: OTP sign-in, signup proof, choosing between
// several businesses, owner password login, refresh, logout, session-version revocation, and the
// requireSellerActive / authorizeSellerRole guards. In-memory MongoDB + an in-memory Redis
// stand-in (test-utils/fakeRedis.mjs); SMS_PROVIDER is mock, so the dev OTP comes back in the
// send response.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { env } = await import('../config/env.js');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const { sellerAuthLimiter, sellerAuthLimiterKey } = await import('../middleware/rateLimiter.js');
const { requireSellerActive } = await import('../middleware/requireSellerActive.js');
const { authorizeSellerRole } = await import('../middleware/authorizeSellerRole.js');
const { SELLER_PERMISSIONS, SELLER_ROLES, SELLER_STATUSES } = await import('../config/coupon.config.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let category;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Seller.init(), SellerUser.init(), CouponCategory.init()]);
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await sellerAuthLimiter.resetKey(sellerAuthLimiterKey(ip));
  category = await CouponCategory.create({ key: 'salon', name: 'Salon' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PHONE = '9876543210';
const post = (path, body, headers = {}) => srv.request('POST', `/api/seller/auth${path}`, { body, headers });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const me = (token) => srv.get('/api/seller/auth/me', bearer(token));

const makeSeller = (over = {}) => Seller.create({ businessName: 'Glow Salon', categoryId: category._id, ...over });
const makeUser = (seller, over = {}) =>
  SellerUser.create({ sellerId: seller._id, name: 'Asha', phone: PHONE, role: 'owner', ...over });

const sendCode = async (phone = PHONE) => {
  const res = await post('/otp/send', { phone });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.devOtp;
};

// Full OTP sign-in for `phone`; returns the verify response.
const otpSignIn = async (phone = PHONE) => {
  const code = await sendCode(phone);
  return post('/otp/verify', { phone, code });
};

const refreshCookieFrom = (res) => {
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(/yulo_rt_seller=([^;]*)/);
  return match ? match[1] : null;
};

// ── OTP sign-in ───────────────────────────────────────────────────────────────

test('a single login: OTP verify starts a session with the role permissions and a refresh cookie', async () => {
  const seller = await makeSeller();
  const user = await makeUser(seller);
  const res = await otpSignIn();

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { accessToken, user: u, seller: s, permissions } = res.body.data;
  assert.ok(accessToken);
  assert.equal(String(u._id), String(user._id));
  assert.equal(u.role, 'owner');
  assert.equal(s.businessName, 'Glow Salon');
  assert.equal(s.status, 'pending');
  assert.deepEqual(permissions, [...SELLER_PERMISSIONS.owner]);
  assert.ok(refreshCookieFrom(res), 'refresh token set in the seller cookie');
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);

  const decoded = jwt.verify(accessToken, env.JWT_SELLER_SECRET);
  assert.equal(decoded.typ, 'access');
  assert.equal(decoded.sellerId, String(seller._id));
  assert.equal(decoded.sv, 0);

  const session = await me(accessToken);
  assert.equal(session.status, 200);
  assert.equal(session.body.data.user.name, 'Asha');
  assert.equal(session.body.data.hasPassword, false);
  assert.ok((await SellerUser.findById(user._id).lean()).lastLoginAt, 'lastLoginAt recorded');
});

test('every common way of writing the number reaches the same login', async () => {
  await makeUser(await makeSeller());
  const code = await sendCode('+91 98765 43210');
  const res = await post('/otp/verify', { phone: '09876543210', code });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.accessToken);
});

test('a number with no login gets a signup proof instead of a session', async () => {
  const res = await otpSignIn();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.needsSignup, true);
  assert.equal(res.body.data.accessToken, undefined);
  assert.equal(refreshCookieFrom(res), null);
  const proof = jwt.verify(res.body.data.signupToken, env.JWT_SELLER_SECRET);
  assert.equal(proof.typ, 'signup');
  assert.equal(proof.phone, PHONE);
  assert.ok(proof.exp - proof.iat <= auth.SELLER_PROOF_SECONDS);
  // The proof is not a session.
  assert.equal((await me(res.body.data.signupToken)).status, 401);
});

test('a deactivated login counts as no login', async () => {
  await makeUser(await makeSeller(), { isActive: false });
  const res = await otpSignIn();
  assert.equal(res.body.data.needsSignup, true);
});

test('wrong and reused codes are refused', async () => {
  await makeUser(await makeSeller());
  const code = await sendCode();
  const wrong = code === '000000' ? '111111' : '000000';
  const bad = await post('/otp/verify', { phone: PHONE, code: wrong });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_OTP');

  assert.equal((await post('/otp/verify', { phone: PHONE, code })).status, 200);
  const reused = await post('/otp/verify', { phone: PHONE, code });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.code, 'OTP_EXPIRED');
});

test('a code requested for a customer login cannot finish a seller sign-in', async () => {
  await makeUser(await makeSeller());
  const { devOtp } = await otp.requestOtp(PHONE); // unscoped = the customer/partner namespace
  const res = await post('/otp/verify', { phone: PHONE, code: devOtp });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'OTP_EXPIRED');
});

test('the per-number send limit applies', async () => {
  for (let i = 0; i < env.OTP_MAX_REQUESTS_PER_WINDOW; i += 1) await sendCode();
  const res = await post('/otp/send', { phone: PHONE });
  assert.equal(res.status, 429);
});

test('input is validated', async () => {
  for (const [path, body] of [
    ['/otp/send', { phone: '12345' }],
    ['/otp/send', { phone: PHONE, extra: 1 }],
    ['/otp/send', {}],
    ['/otp/verify', { phone: PHONE, code: '12ab56' }],
    ['/otp/verify', { phone: PHONE }],
    ['/select-account', { selectToken: 'x', sellerUserId: 'not-an-id' }],
    ['/login', { phone: PHONE }],
  ]) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
});

// ── Several businesses on one number ──────────────────────────────────────────

test('a number with logins at two sellers chooses one; the choice token works once', async () => {
  const a = await makeSeller({ businessName: 'A Salon' });
  const b = await makeSeller({ businessName: 'B Spa', status: 'active' });
  const ua = await makeUser(a, { role: 'owner' });
  const ub = await makeUser(b, { role: 'employee' });

  const res = await otpSignIn();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.needsAccountChoice, true);
  assert.equal(res.body.data.accessToken, undefined);
  const accounts = res.body.data.accounts;
  assert.deepEqual(accounts.map((x) => x.businessName), ['A Salon', 'B Spa']);
  assert.deepEqual(accounts.map((x) => x.role), ['owner', 'employee']);

  const { selectToken } = res.body.data;
  const chosen = await post('/select-account', { selectToken, sellerUserId: String(ub._id) });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.equal(chosen.body.data.user.role, 'employee');
  assert.deepEqual(chosen.body.data.permissions, ['redeem']);
  assert.equal(chosen.body.data.seller.businessName, 'B Spa');

  const again = await post('/select-account', { selectToken, sellerUserId: String(ua._id) });
  assert.equal(again.status, 401, 'the choice token is single-use');
});

test('the choice token only opens the accounts it offered', async () => {
  const a = await makeSeller();
  const b = await makeSeller();
  await makeUser(a);
  await makeUser(b);
  const outsider = await makeUser(await makeSeller(), { phone: '9000000009' });
  const { selectToken } = (await otpSignIn()).body.data;

  const res = await post('/select-account', { selectToken, sellerUserId: String(outsider._id) });
  assert.equal(res.status, 403);
});

test('a login deactivated between the OTP and the choice is refused', async () => {
  const a = await makeSeller();
  const ua = await makeUser(a);
  await makeUser(await makeSeller());
  const { selectToken } = (await otpSignIn()).body.data;
  await SellerUser.updateOne({ _id: ua._id }, { isActive: false });
  const res = await post('/select-account', { selectToken, sellerUserId: String(ua._id) });
  assert.equal(res.status, 401);
});

// ── Which tokens the seller API accepts ───────────────────────────────────────

test('no token, a forged token, and every other kind of token are refused', async () => {
  const seller = await makeSeller();
  const user = await makeUser(seller);
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  const { accessToken, refreshToken } = auth.generateSellerTokens(user);

  assert.equal((await srv.get('/api/seller/auth/me')).status, 401);
  assert.equal((await me('garbage')).status, 401);
  assert.equal((await me(auth.generateTokens(customer._id, 'customer').accessToken)).status, 401, 'customer token');
  assert.equal((await me(auth.generateStaffToken(user._id, 'waiter', seller._id, 0))).status, 401, 'staff token');
  assert.equal((await me(refreshToken)).status, 401, 'a refresh token is not an access token');
  const forged = jwt.sign({ sellerUserId: String(user._id), sellerId: String(seller._id), role: 'owner', sv: 0, typ: 'access' }, env.JWT_ACCESS_SECRET);
  assert.equal((await me(forged)).status, 401, 'signed with another secret');
  const expired = jwt.sign({ sellerUserId: String(user._id), sv: 0, typ: 'access' }, env.JWT_SELLER_SECRET, { expiresIn: -10 });
  assert.equal((await me(expired)).status, 401, 'expired');
  assert.equal((await me(accessToken)).status, 200, 'the real one works');
});

test('bumping the session version or deactivating the user ends the session at once', async () => {
  const user = await makeUser(await makeSeller());
  const { accessToken } = auth.generateSellerTokens(user);
  assert.equal((await me(accessToken)).status, 200);

  await SellerUser.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
  const bumped = await me(accessToken);
  assert.equal(bumped.status, 401);
  assert.match(bumped.body.message, /session has ended/i);

  const fresh = auth.generateSellerTokens(await SellerUser.findById(user._id).lean()).accessToken;
  assert.equal((await me(fresh)).status, 200);
  await SellerUser.updateOne({ _id: user._id }, { isActive: false });
  assert.equal((await me(fresh)).status, 401);
});

test('a role change applies on the next request, not at the next sign-in', async () => {
  const user = await makeUser(await makeSeller(), { role: 'manager' });
  const { accessToken } = auth.generateSellerTokens(user);
  await SellerUser.updateOne({ _id: user._id }, { role: 'employee' });
  const res = await me(accessToken);
  assert.equal(res.body.data.user.role, 'employee');
  assert.deepEqual(res.body.data.permissions, ['redeem']);
});

test('a pending or rejected seller can still sign in and see its status', async () => {
  const rejected = await makeSeller({ status: 'rejected', rejectionReason: 'GST certificate unreadable' });
  await makeUser(rejected);
  const res = await otpSignIn();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.seller.status, 'rejected');
  assert.equal(res.body.data.seller.rejectionReason, 'GST certificate unreadable');
});

test('without JWT_SELLER_SECRET seller sign-in answers 503, not a crash', async () => {
  const user = await makeUser(await makeSeller());
  const saved = env.JWT_SELLER_SECRET;
  env.JWT_SELLER_SECRET = undefined;
  try {
    assert.throws(() => auth.generateSellerTokens(user), (err) => err.code === 'SELLER_AUTH_NOT_CONFIGURED' && err.statusCode === 503);
    const res = await me('anything');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'SELLER_AUTH_NOT_CONFIGURED');
  } finally {
    env.JWT_SELLER_SECRET = saved;
  }
});

// ── Refresh & logout ──────────────────────────────────────────────────────────

test('refresh mints a new access token from the cookie', async () => {
  await makeUser(await makeSeller());
  const signIn = await otpSignIn();
  const cookie = refreshCookieFrom(signIn);
  const res = await post('/refresh', undefined, { cookie: `yulo_rt_seller=${cookie}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await me(res.body.data.accessToken)).status, 200);

  assert.equal((await post('/refresh')).status, 401, 'no cookie');
  assert.equal((await post('/refresh', undefined, { cookie: 'yulo_rt_seller=garbage' })).status, 401);
});

test('refresh refuses a bumped or deactivated user, and an access token in place of a refresh token', async () => {
  const user = await makeUser(await makeSeller());
  const { accessToken, refreshToken } = auth.generateSellerTokens(user);
  assert.equal((await post('/refresh', undefined, { cookie: `yulo_rt_seller=${accessToken}` })).status, 401);

  await SellerUser.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
  assert.equal((await post('/refresh', undefined, { cookie: `yulo_rt_seller=${refreshToken}` })).status, 401);
});

test('the seller cookie never yields a customer/owner/admin session', async () => {
  const user = await makeUser(await makeSeller());
  const { refreshToken } = auth.generateSellerTokens(user);
  const res = await srv.request('POST', '/api/auth/refresh?portal=seller', { headers: { cookie: `yulo_rt_seller=${refreshToken}` } });
  assert.equal(res.status, 401);
});

test('logout revokes the access token and the refresh token, and clears the cookie', async () => {
  await makeUser(await makeSeller());
  const signIn = await otpSignIn();
  const { accessToken } = signIn.body.data;
  const cookie = `yulo_rt_seller=${refreshCookieFrom(signIn)}`;

  const out = await post('/logout', undefined, { ...bearer(accessToken), cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /yulo_rt_seller=;/);
  assert.equal((await me(accessToken)).status, 401);
  assert.equal((await post('/refresh', undefined, { cookie })).status, 401);
  assert.equal((await post('/logout')).status, 401, 'logout needs a session');
});

// ── Owner password ────────────────────────────────────────────────────────────

test('an owner sets a password, signs in with it, and must give the old one to change it', async () => {
  const user = await makeUser(await makeSeller());
  const { accessToken } = auth.generateSellerTokens(user);

  assert.equal((await post('/password', { newPassword: 'short' }, bearer(accessToken))).status, 400);
  assert.equal((await post('/password', { newPassword: 'first-pass-123' }, bearer(accessToken))).status, 200);
  assert.equal((await me(accessToken)).body.data.hasPassword, true);
  const stored = await SellerUser.findById(user._id).select('+passwordHash').lean();
  assert.match(stored.passwordHash, /^\$argon2id\$/);

  const login = await post('/login', { phone: PHONE, password: 'first-pass-123' });
  assert.equal(login.status, 200);
  assert.ok(login.body.data.accessToken);
  assert.ok(refreshCookieFrom(login));

  const noCurrent = await post('/password', { newPassword: 'second-pass-456' }, bearer(accessToken));
  assert.equal(noCurrent.status, 401);
  const wrongCurrent = await post('/password', { currentPassword: 'nope', newPassword: 'second-pass-456' }, bearer(accessToken));
  assert.equal(wrongCurrent.status, 401);
  const ok = await post('/password', { currentPassword: 'first-pass-123', newPassword: 'second-pass-456' }, bearer(accessToken));
  assert.equal(ok.status, 200);
  assert.equal((await post('/login', { phone: PHONE, password: 'first-pass-123' })).status, 401);
  assert.equal((await post('/login', { phone: PHONE, password: 'second-pass-456' })).status, 200);
});

test('password login gives one answer for every failure and is owners-only', async () => {
  const seller = await makeSeller();
  const owner = await makeUser(seller);
  await post('/password', { newPassword: 'owner-pass-123' }, bearer(auth.generateSellerTokens(owner).accessToken));

  const wrongPassword = await post('/login', { phone: PHONE, password: 'wrong-pass' });
  const unknownNumber = await post('/login', { phone: '9123456780', password: 'owner-pass-123' });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownNumber.status, 401);
  assert.equal(wrongPassword.body.message, unknownNumber.body.message);

  // A manager with a password hash (never settable through the API) still can't use it.
  const manager = await makeUser(seller, { phone: '9111111111', role: 'manager' });
  await SellerUser.updateOne({ _id: manager._id }, { passwordHash: await auth.hashPassword('manager-pass-1') });
  assert.equal((await post('/login', { phone: '9111111111', password: 'manager-pass-1' })).status, 401);
});

test('managers and employees cannot set a password', async () => {
  const seller = await makeSeller();
  for (const role of ['manager', 'employee']) {
    const user = await makeUser(seller, { role, phone: role === 'manager' ? '9111111111' : '9222222222' });
    const res = await post('/password', { newPassword: 'some-pass-123' }, bearer(auth.generateSellerTokens(user).accessToken));
    assert.equal(res.status, 403, role);
  }
});

// ── Guards for later routes ───────────────────────────────────────────────────

// Runs a synchronous Express middleware against a request; returns the error it threw, or null.
const run = (middleware, req) => {
  let passed = false;
  try {
    middleware(req, {}, () => {
      passed = true;
    });
  } catch (err) {
    return err;
  }
  return passed ? null : new Error('middleware neither passed nor threw');
};

test('requireSellerActive lets only an active seller through', () => {
  for (const status of SELLER_STATUSES) {
    const err = run(requireSellerActive, { seller: { sellerStatus: status } });
    if (status === 'active') assert.equal(err, null);
    else {
      assert.equal(err?.statusCode, 403, status);
      assert.equal(err.code, 'SELLER_NOT_ACTIVE');
      assert.equal(err.details?.sellerStatus, status);
    }
  }
  assert.equal(run(requireSellerActive, {})?.code, 'SELLER_NOT_ACTIVE');
});

test('authorizeSellerRole: the full role matrix', () => {
  const guards = {
    ownerOnly: authorizeSellerRole('owner'),
    ownerOrManager: authorizeSellerRole('owner', 'manager'),
    anyone: authorizeSellerRole('owner', 'manager', 'employee'),
  };
  const allowed = {
    ownerOnly: ['owner'],
    ownerOrManager: ['owner', 'manager'],
    anyone: ['owner', 'manager', 'employee'],
  };
  for (const [name, guard] of Object.entries(guards)) {
    for (const role of SELLER_ROLES) {
      const err = run(guard, { seller: { role } });
      if (allowed[name].includes(role)) assert.equal(err, null, `${name} ${role}`);
      else assert.equal(err?.statusCode, 403, `${name} ${role}`);
    }
    assert.equal(run(guard, {})?.statusCode, 403, `${name} without a seller`);
  }
});

test('every role has a permission list, and employees can only redeem', () => {
  for (const role of SELLER_ROLES) assert.ok(SELLER_PERMISSIONS[role]?.length, role);
  assert.deepEqual([...SELLER_PERMISSIONS.employee], ['redeem']);
  assert.ok(!SELLER_PERMISSIONS.manager.includes('plans.buy'));
  assert.ok(!SELLER_PERMISSIONS.manager.includes('agreement.accept'));
});

// ── Rate limit (last: it spends the IP's budget) ──────────────────────────────

test('sign-in endpoints are rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 61; i += 1) last = await post('/otp/verify', { phone: PHONE, code: '123456' });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'RATE_LIMITED');
});

// ── Production configuration ──────────────────────────────────────────────────

test('production refuses to boot without JWT_SELLER_SECRET, or with a placeholder one', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const prodEnv = {
    PATH: process.env.PATH,
    DOTENV_CONFIG_PATH: fileURLToPath(new URL('../test-utils/empty.env', import.meta.url)),
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:1/never-connected',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    JWT_STAFF_SECRET: 'c'.repeat(48),
    JWT_PARTNER_SECRET: 'd'.repeat(48),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    LOG_LEVEL: 'silent',
  };
  const load = (extra) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config/env.js')"], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...prodEnv, ...extra },
      encoding: 'utf8',
    });

  const missing = load({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /JWT_SELLER_SECRET is not set/);

  const placeholder = load({ JWT_SELLER_SECRET: 'replace_in_production_seller_secret_value_000' });
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /JWT_SELLER_SECRET/);

  const ok = load({ JWT_SELLER_SECRET: 'e'.repeat(48) });
  assert.equal(ok.status, 0, ok.stderr);
});
