// Every coupon API call and its expected response. One business world is built step by step
// (seller sign-up → approval → plan → offers → a paying customer → redemption → reports → team →
// credits → admin tools), and EVERY route under /api/seller, /api/admin/coupon*,
// /api/admin/sellers, /api/admin/reminder-campaigns and /api/users/me/coupons is called with a
// valid request; its status, message, response keys and the values that matter are asserted.
// The last test fails if any mounted coupon route was never called here (router walk), so a new
// route can't ship without a response check. Coupon fields added to existing endpoints
// (PATCH /api/users/me, GET /api/orders/:id, the bill payment status) are checked too.
// In-memory MongoDB and Redis; Razorpay, Cloudinary and SMS are stubs — nothing leaves the process.

import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  seedBasics,
  createPendingOnlineOrder,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { installRouteRecorder, mountedRoutes, COUPON_ROUTE_SCOPE } = await import('../test-utils/routeRecorder.mjs');
const recorder = installRouteRecorder();
const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { app } = await import('../app.js');
recorder.uninstall();

const fx = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const issue = await import('../services/couponIssue.service.js');
const sms = await import('../services/sms/templateSender.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: User } = await import('../models/User.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const models = await Promise.all(
  ['Seller', 'SellerSubscription', 'SmsLog', 'SmsCampaign', 'SmsCreditPurchase', 'WebhookEvent', 'IdempotencyKey', 'RestaurantLedgerEntry', 'CouponPlan', 'StrayPayment'].map(
    async (m) => (await import(`../models/${m}.js`)).default
  )
);

const redis = fakeRedis();
let mongo;
let srv;
let fake;
let cloud;
let fetchStub;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Coupon.init(), SellerUser.init(), ...models.map((m) => m.init())]);
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  redemption.__setRedeemRedisForTests(redis);
  srv = await startTestServer({ withSocket: true });
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  cloud = await fx.mockCloudinary();
  // Document downloads stream the file from Cloudinary: answer for the fake Cloudinary host only.
  const realFetch = globalThis.fetch;
  fetchStub = mock.method(globalThis, 'fetch', async (url, init) =>
    String(url).startsWith('https://res.example.invalid/')
      ? new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } })
      : realFetch(url, init)
  );
  __resetCouponSettingsCache();
  __resetFinanceSettingsCache();
  sms.__clearMockOutbox();
});
after(async () => {
  fetchStub?.mock.restore();
  cloud?.restore();
  __setRazorpayForTests(undefined);
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  redemption.__setRedeemRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const called = new Set();
const ctx = {}; // ids and tokens built up by the steps

/**
 * Calls `METHOD pattern` (":name" filled from `params`), records the route as covered, and asserts
 * the status. Returns { status, body, headers }.
 */
const call = async (method, pattern, { params = {}, body, headers = {}, raw = false, status = 200 } = {}) => {
  called.add(`${method} ${pattern.split('?')[0]}`);
  const path = pattern.replace(/:(\w+)/g, (_, k) => {
    assert.ok(params[k] !== undefined, `no value for :${k} in ${pattern}`);
    return String(params[k]);
  });
  const res = raw ? await rawGet(path, headers) : await srv.request(method, path, { body, headers });
  assert.equal(res.status, status, `${method} ${pattern}: ${res.status} ${typeof res.body === 'string' ? res.body.slice(0, 300) : JSON.stringify(res.body)}`);
  return res;
};
const rawGet = async (path, headers) => {
  const res = await fetch(srv.base + path, { headers });
  return { status: res.status, body: await res.text(), headers: res.headers };
};

/** The success envelope with exactly these data keys. Returns data. */
const ok = (res, message, dataKeys) => {
  assert.equal(res.body.status, 'success');
  if (message) assert.equal(res.body.message, message);
  if (dataKeys === null) {
    assert.equal(res.body.data, null);
    return null;
  }
  if (dataKeys) assert.deepEqual(Object.keys(res.body.data).sort(), [...dataKeys].sort(), `data keys of "${res.body.message}"`);
  return res.body.data;
};
/** The error envelope. */
const err = (res, code) => {
  assert.equal(res.body.status, 'error');
  assert.equal(res.body.code, code);
  return res.body;
};
const keys = (obj, expected, label = 'object') => assert.deepEqual(Object.keys(obj).sort(), [...expected].sort(), `${label} keys`);
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const SESSION_KEYS = ['accessToken', 'user', 'seller', 'permissions'];
const USER_VIEW = ['_id', 'name', 'phone', 'role', 'sellerId'];
const SELLER_VIEW = ['_id', 'businessName', 'status', 'rejectionReason'];
const OFFER_KEYS = ['_id', 'title', 'terms', 'validityDays', 'status', 'rejectionReason', 'categoryId', 'reviewedAt', 'createdAt', 'updatedAt'];
const ONBOARDING_KEYS = ['status', 'submittedAt', 'rejectionReason', 'editable', 'editableBusinessFields', 'business', 'owner', 'employees', 'documents', 'missing'];
const SELLER_COUPON_ROW = ['id', 'customerName', 'gender', 'ageBand', 'offerTitle', 'category', 'issuedAt', 'expiresAt', 'status', 'redeemedAt', 'redeemedByName'];
const SUB_VIEW = ['_id', 'plan', 'status', 'amount', 'paidPaise', 'method', 'reference', 'allocated', 'issued', 'remaining', 'activatedAt', 'exhaustedAt', 'createdAt'];
const MEMBER_KEYS = ['_id', 'name', 'phone', 'role', 'dateOfBirth', 'gender', 'experienceYears', 'isActive', 'lastLoginAt', 'isYou', 'canManage'];
const ADMIN_ROW = ['id', 'code', 'kind', 'customerName', 'mobile', 'age', 'gender', 'category', 'seller', 'offerTitle', 'source', 'issuedAt', 'expiresAt', 'status', 'redeemedAt', 'redeemedBy'];
const COUNTS = ['issued', 'active', 'redeemed', 'expired', 'void', 'redemptionRate'];

const OWNER_PHONE = '9822222221';
const MANAGER_PHONE = '9833333331';

// ── 1. Seller sign-in ─────────────────────────────────────────────────────────

test('seller sign-in: categories, OTP, signup, refresh, me, status, password, login', async () => {
  await seedCouponData({ apply: true, log: () => {} });
  ctx.base = await seedBasics();
  ctx.salon = await CouponCategory.findOne({ key: 'salon' }).lean();
  const admin = await User.create({ name: 'Root', email: 'root@test.local', role: 'admin' });
  ctx.adminH = bearer(auth.generateTokens(admin._id, 'admin').accessToken);
  ctx.customerH = bearer(ctx.base.customerToken);

  const cats = ok(await call('GET', '/api/seller/auth/categories'), 'Categories', ['categories']);
  assert.equal(cats.categories.length, 5);
  keys(cats.categories[0], ['_id', 'key', 'name', 'icon'], 'category');

  const sent = ok(await call('POST', '/api/seller/auth/otp/send', { body: { phone: `+91 ${OWNER_PHONE}` } }), 'A code has been sent', ['phone', 'devOtp']);
  assert.equal(sent.phone, OWNER_PHONE);
  assert.match(sent.devOtp, /^\d{6}$/);

  const verified = ok(await call('POST', '/api/seller/auth/otp/verify', { body: { phone: OWNER_PHONE, code: sent.devOtp } }), 'No seller account uses this number yet', ['needsSignup', 'phone', 'signupToken']);
  assert.equal(verified.needsSignup, true);

  const signupRes = await call('POST', '/api/seller/auth/signup', {
    body: { signupToken: verified.signupToken, businessName: 'Glow Salon', categoryId: String(ctx.salon._id), ownerName: 'Asha Rao' },
    status: 201,
  });
  const signup = ok(signupRes, 'Business created — complete your details to send it for review', SESSION_KEYS);
  keys(signup.user, USER_VIEW, 'user');
  keys(signup.seller, SELLER_VIEW, 'seller');
  assert.equal(signup.user.role, 'owner');
  assert.equal(signup.seller.status, 'pending');
  assert.ok(signup.permissions.includes('plans.buy'));
  ctx.ownerH = bearer(signup.accessToken);
  ctx.sellerId = signup.seller._id;
  ctx.ownerId = signup.user._id;
  const cookie = signupRes.headers.get('set-cookie');
  assert.match(cookie, /yulo_rt_seller=/);
  assert.match(cookie, /HttpOnly/i);

  const refreshed = ok(await call('POST', '/api/seller/auth/refresh', { headers: { cookie: cookie.split(';')[0] } }), 'Token refreshed', ['accessToken']);
  assert.ok(refreshed.accessToken.length > 20);

  const me = ok(await call('GET', '/api/seller/auth/me', { headers: ctx.ownerH }), 'Seller session', ['user', 'seller', 'permissions', 'hasPassword', 'expiresAt']);
  assert.equal(me.hasPassword, false);
  assert.ok(me.expiresAt);

  const status = ok(await call('GET', '/api/seller/status', { headers: ctx.ownerH }), 'Status', ['status', 'submittedAt', 'reviewedAt', 'rejectionReason']);
  assert.deepEqual(status, { status: 'pending', submittedAt: null, reviewedAt: null, rejectionReason: null });

  ok(await call('POST', '/api/seller/auth/password', { headers: ctx.ownerH, body: { newPassword: 'Glow#2026salon' } }), 'Password saved', null);
  const login = ok(await call('POST', '/api/seller/auth/login', { body: { phone: OWNER_PHONE, password: 'Glow#2026salon' } }), 'Login successful', SESSION_KEYS);
  assert.equal(login.user._id, ctx.ownerId);
  err(await srv.request('POST', '/api/seller/auth/login', { body: { phone: OWNER_PHONE, password: 'wrong-password' } }), 'INVALID_CREDENTIALS');
});

// ── 2. Onboarding ─────────────────────────────────────────────────────────────

test('onboarding: form, business, owner, team, documents (upload, download, delete), submit', async () => {
  const H = ctx.ownerH;
  const form = ok(await call('GET', '/api/seller/onboarding', { headers: H }), 'Onboarding', ONBOARDING_KEYS);
  assert.equal(form.editable, true);
  assert.deepEqual(form.missing, ['business', 'owner', 'document:pan_card', 'document:aadhaar_card']);

  const business = ok(await call('PUT', '/api/seller/onboarding/business', { headers: H, body: fx.businessBody(ctx.salon._id) }), 'Business details saved', ONBOARDING_KEYS);
  assert.deepEqual(business.business.location, { lng: 77.59, lat: 12.97 });
  assert.equal(business.business.gstNumber, fx.VALID.gstin);

  const owner = ok(await call('PUT', '/api/seller/onboarding/owner', { headers: H, body: fx.ownerBody({ phone: OWNER_PHONE }) }), 'Owner details saved', ONBOARDING_KEYS);
  keys(owner.owner, ['name', 'dateOfBirth', 'phone', 'panMasked', 'aadhaarMasked'], 'owner');
  assert.equal(owner.owner.panMasked, '******234F');
  assert.equal(owner.owner.aadhaarMasked, 'XXXX XXXX 2346');
  // The GSTIN embeds the PAN by design, so look for the PAN in the owner section only.
  assert.ok(!JSON.stringify(owner.owner).includes(fx.VALID.pan), 'PAN masked');

  const team = ok(await call('PUT', '/api/seller/onboarding/employees', {
    headers: H,
    body: { employees: [{ name: 'Meera Nair', phone: MANAGER_PHONE, role: 'manager', gender: 'female' }] },
  }), 'Team saved', ONBOARDING_KEYS);
  assert.equal(team.employees.length, 1);
  keys(team.employees[0], ['_id', 'name', 'phone', 'role', 'dateOfBirth', 'gender', 'experienceYears', 'isActive'], 'employee');
  assert.equal(team.employees[0].isActive, false, 'inactive until approval');

  const docIds = {};
  for (const type of ['pan_card', 'aadhaar_card', 'gst_certificate', 'shop_photo']) {
    const up = await fx.uploadFile(srv.base, '/api/seller/onboarding/documents', H, { type });
    called.add('POST /api/seller/onboarding/documents');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.message, 'Document uploaded');
    const doc = up.body.data.documents.find((d) => d.type === type);
    keys(doc, ['_id', 'type', 'name', 'mimeType', 'status', 'uploadedAt'], 'document');
    assert.ok(!('url' in doc), 'storage URL never returned');
    docIds[type] = doc._id;
  }
  ctx.panDocId = docIds.pan_card;

  const file = await call('GET', '/api/seller/onboarding/documents/:docId/file', { params: { docId: docIds.pan_card }, headers: H, raw: true });
  assert.equal(file.body, 'PNGDATA');
  assert.match(file.headers.get('content-type'), /image\/png/);

  const removed = ok(await call('DELETE', '/api/seller/onboarding/documents/:docId', { params: { docId: docIds.shop_photo }, headers: H }), 'Document removed', ['documents']);
  assert.equal(removed.documents.length, 3);

  const submitted = ok(await call('POST', '/api/seller/onboarding/submit', { headers: H }), 'Sent for review', ONBOARDING_KEYS);
  assert.deepEqual(submitted.missing, []);
  assert.ok(submitted.submittedAt);
});

// ── 3. Admin: sellers ─────────────────────────────────────────────────────────

test('admin sellers: list, detail, users, PAN reveal, document, approve / reject / suspend / reactivate', async () => {
  const H = ctx.adminH;
  const list = ok(await call('GET', '/api/admin/sellers', { headers: H }), 'Sellers', ['sellers', 'total', 'page', 'pages', 'statusCounts']);
  assert.equal(list.total, 1);
  keys(list.sellers[0], ['_id', 'businessName', 'category', 'status', 'city', 'ownerName', 'ownerPhone', 'submittedAt', 'reviewedAt', 'createdAt', 'complete'], 'seller row');
  assert.equal(list.sellers[0].complete, true);
  assert.equal(list.statusCounts.pending, 1);

  const detail = ok(await call('GET', '/api/admin/sellers/:id', { params: { id: ctx.sellerId }, headers: H }), 'Seller', ['seller']).seller;
  for (const k of ['_id', 'status', 'business', 'owner', 'users', 'documents', 'missing', 'smsCreditsBalance']) assert.ok(k in detail, `seller detail has ${k}`);
  assert.equal(detail.owner.panMasked, '******234F');
  assert.equal(detail.owner.panRevealable, true);
  assert.ok(!JSON.stringify(detail.owner).includes(fx.VALID.pan), 'PAN masked in the detail');

  const users = ok(await call('GET', '/api/admin/sellers/:id/users', { params: { id: ctx.sellerId }, headers: H }), 'Seller users', ['users']).users;
  assert.deepEqual(users.map((u) => u.role).sort(), ['manager', 'owner']);

  const revealed = ok(await call('POST', '/api/admin/sellers/:id/reveal', { params: { id: ctx.sellerId }, headers: H, body: { field: 'pan' } }), 'Identity number', ['field', 'value']);
  assert.deepEqual(revealed, { field: 'pan', value: fx.VALID.pan });
  err(await srv.request('POST', `/api/admin/sellers/${ctx.sellerId}/reveal`, { headers: H, body: { field: 'aadhaar' } }), 'NOT_STORED');

  const file = await call('GET', '/api/admin/sellers/:id/documents/:docId/file', { params: { id: ctx.sellerId, docId: ctx.panDocId }, headers: H, raw: true });
  assert.equal(file.body, 'PNGDATA');

  const approved = ok(await call('PATCH', '/api/admin/sellers/:id/approve', { params: { id: ctx.sellerId }, headers: H }), 'Seller approved', ['seller']).seller;
  assert.equal(approved.status, 'active');
  assert.equal((await SellerUser.findOne({ phone: MANAGER_PHONE }).lean()).isActive, true, 'team activated');

  // A second application to reject, a third business to suspend and reactivate.
  const rejectMe = await fx.makeCompleteSeller({ status: 'pending', categoryId: ctx.salon._id, phone: '9000000002' });
  const rejected = ok(await call('PATCH', '/api/admin/sellers/:id/reject', { params: { id: rejectMe.seller._id }, headers: H, body: { reason: 'PAN card photo is blurred' } }), 'Seller rejected', ['seller']).seller;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'PAN card photo is blurred');

  const spa = await CouponCategory.findOne({ key: 'spa' }).lean();
  ctx.spa = spa;
  const other = await fx.makeCompleteSeller({ status: 'active', categoryId: spa._id, phone: '9000000003' });
  ctx.otherSellerId = String(other.seller._id);
  const suspended = ok(await call('PATCH', '/api/admin/sellers/:id/suspend', { params: { id: other.seller._id }, headers: H, body: { reason: 'Unpaid dues' } }), 'Seller suspended', ['seller']).seller;
  assert.equal(suspended.status, 'suspended');
  const reactivated = ok(await call('PATCH', '/api/admin/sellers/:id/reactivate', { params: { id: other.seller._id }, headers: H }), 'Seller reactivated', ['seller']).seller;
  assert.equal(reactivated.status, 'active');

  const none = ok(await call('GET', '/api/admin/sellers/:id/subscriptions', { params: { id: other.seller._id }, headers: H }), 'Subscriptions', ['subscriptions']);
  assert.deepEqual(none.subscriptions, []);
  const manual = ok(await call('POST', '/api/admin/sellers/:id/subscriptions/manual', {
    params: { id: other.seller._id },
    headers: H,
    body: { planKey: 'plus', amountRupees: 17700, mode: 'neft', reference: 'UTR000111222', receivedOn: '2026-11-01' },
    status: 201,
  }), 'Payment recorded — plan activated', ['subscription']).subscription;
  keys(manual, [...SUB_VIEW, 'payment', 'complimentary'], 'admin subscription');
  assert.equal(manual.status, 'active');
  assert.equal(manual.remaining, 900);
  assert.equal(manual.plan.complimentaryCount, 5, 'the admin sees complimentary counts');
  const subs = ok(await call('GET', '/api/admin/sellers/:id/subscriptions', { params: { id: other.seller._id }, headers: H }), 'Subscriptions', ['subscriptions']);
  assert.equal(subs.subscriptions.length, 1);

  const credits = ok(await call('POST', '/api/admin/sellers/:id/sms-credits/manual', {
    params: { id: ctx.sellerId },
    headers: H,
    body: { credits: 50, amountRupees: 177, mode: 'upi', reference: 'UPI-CREDITS-01', receivedOn: '2026-11-01' },
    status: 201,
  }), 'Payment recorded — credits added', ['purchase', 'balance']);
  assert.equal(credits.balance, 50);
  keys(credits.purchase, ['_id', 'credits', 'status', 'amount', 'method', 'reference', 'paidAt', 'creditedAt', 'createdAt'], 'credit purchase');
  assert.deepEqual(credits.purchase.amount, { pricePaise: 15_000, gstPaise: 2_700, totalPaise: 17_700, total: 177 });
});

test('select-account: one number with logins at two businesses chooses which to open', async () => {
  // The manager of Glow Salon is also an employee of the other business.
  await SellerUser.create({ sellerId: ctx.otherSellerId, name: 'Meera Nair', phone: MANAGER_PHONE, role: 'employee' });
  const { devOtp } = (await srv.request('POST', '/api/seller/auth/otp/send', { body: { phone: MANAGER_PHONE } })).body.data;
  const choice = ok(await call('POST', '/api/seller/auth/otp/verify', { body: { phone: MANAGER_PHONE, code: devOtp } }), 'Choose which business to sign in to', ['needsAccountChoice', 'selectToken', 'accounts']);
  assert.equal(choice.accounts.length, 2);
  keys(choice.accounts[0], ['sellerUserId', 'sellerId', 'businessName', 'sellerStatus', 'role'], 'account');
  const glow = choice.accounts.find((a) => a.businessName === 'Glow Salon');
  const session = ok(await call('POST', '/api/seller/auth/select-account', { body: { selectToken: choice.selectToken, sellerUserId: glow.sellerUserId } }), 'Login successful', SESSION_KEYS);
  assert.equal(session.user.role, 'manager');
  ctx.managerH = bearer(session.accessToken);
});

// ── 4. Plans ──────────────────────────────────────────────────────────────────

test('plans: list, purchase through Razorpay, verify, stock; simulate is off outside development', async () => {
  const H = ctx.ownerH;
  const plans = ok(await call('GET', '/api/seller/plans', { headers: H }), 'Plans', ['plans']).plans;
  keys(plans[0], ['_id', 'key', 'name', 'gstPercent', 'couponAllocation', 'basePaise', 'gstPaise', 'totalPaise', 'price', 'isActive', 'sortOrder'], 'plan');
  assert.deepEqual(plans.map((p) => [p.key, p.price.total, p.couponAllocation]), [['basic', 5900, 250], ['plus', 17700, 900], ['premium', 59000, 4000]]);

  const empty = ok(await call('GET', '/api/seller/subscriptions', { headers: H }), 'Subscriptions', ['subscriptions', 'stock', 'currentPlan', 'activePlans']);
  assert.deepEqual(empty.stock, { allocated: 0, issued: 0, remaining: 0 });

  const started = ok(await call('POST', '/api/seller/subscriptions', { headers: H, body: { planKey: 'basic' }, status: 201 }), 'Plan purchase started', ['subscription', 'razorpayOrder', 'paymentSimulated']);
  keys(started.subscription, SUB_VIEW, 'subscription');
  assert.equal(started.subscription.status, 'pending_payment');
  keys(started.razorpayOrder, ['id', 'amount', 'currency', 'keyId'], 'razorpayOrder');
  assert.equal(started.razorpayOrder.amount, 590_000);
  assert.equal(started.paymentSimulated, false);

  fake.addPayment({ id: 'pay_plan_1', order_id: started.razorpayOrder.id, amount: 590_000 });
  const verified = ok(await call('POST', '/api/seller/subscriptions/:id/verify', {
    params: { id: started.subscription._id },
    headers: H,
    body: { razorpay_order_id: started.razorpayOrder.id, razorpay_payment_id: 'pay_plan_1', razorpay_signature: checkoutSignature(started.razorpayOrder.id, 'pay_plan_1') },
  }), 'Plan activated', ['subscription']).subscription;
  assert.equal(verified.status, 'active');
  assert.deepEqual([verified.allocated, verified.issued, verified.remaining], [250, 0, 250]);
  assert.ok(!JSON.stringify(verified).match(/complimentary/i), 'sellers never see complimentary counts');

  err(await call('POST', '/api/seller/subscriptions/:id/simulate-payment', { params: { id: started.subscription._id }, headers: H, status: 404 }), 'NOT_FOUND');
  const after = ok(await call('GET', '/api/seller/subscriptions', { headers: H }), 'Subscriptions', ['subscriptions', 'stock', 'currentPlan', 'activePlans']);
  assert.deepEqual(after.stock, { allocated: 250, issued: 0, remaining: 250 });
  assert.equal(after.currentPlan.plan.key, 'basic');
  assert.deepEqual(after.activePlans, [{ key: 'basic', name: 'Basic' }]);
});

// ── 5. Admin: plans and categories ────────────────────────────────────────────

test('admin plans and categories: list, edit, create, enable', async () => {
  const H = ctx.adminH;
  const plans = ok(await call('GET', '/api/admin/coupon-plans', { headers: H }), 'Coupon plans', ['plans']).plans;
  assert.deepEqual(plans.map((p) => p.complimentaryCount), [5, 5, 5]);
  const edited = ok(await call('PUT', '/api/admin/coupon-plans/:key', { params: { key: 'premium' }, headers: H, body: { couponAllocation: 4500 } }), 'Plan saved — applies to new purchases', ['plan']).plan;
  assert.equal(edited.couponAllocation, 4500);

  const created = ok(await call('POST', '/api/admin/coupon-categories', { headers: H, body: { key: 'pharmacy', name: 'Pharmacy', sortOrder: 9 }, status: 201 }), 'Category created', ['category']).category;
  assert.equal(created.enabled, false);
  err(await srv.request('POST', '/api/admin/coupon-categories', { headers: H, body: { key: 'pharmacy', name: 'Again' } }), 'DUPLICATE_KEY');

  const enabled = ok(await call('PATCH', '/api/admin/coupon-categories/:id', { params: { id: ctx.salon._id }, headers: H, body: { enabled: true } }), 'Customers will now receive these coupons', ['category']).category;
  assert.equal(enabled.enabled, true);
  const list = ok(await call('GET', '/api/admin/coupon-categories', { headers: H }), 'Coupon categories', ['categories']).categories;
  const salon = list.find((c) => c.key === 'salon');
  keys(salon, ['_id', 'key', 'name', 'icon', 'enabled', 'sortOrder', 'activeSellers', 'sellersWithLiveOffer', 'stockRemaining'], 'admin category');
  assert.deepEqual([salon.activeSellers, salon.sellersWithLiveOffer, salon.stockRemaining], [1, 0, 250]);
});

// ── 6. Offers ─────────────────────────────────────────────────────────────────

test('offers: create, list, edit, submit; admin list, approve, reject; pause, resume', async () => {
  const H = ctx.ownerH;
  const draft = ok(await call('POST', '/api/seller/offers', { headers: H, body: { title: '20% off any haircut', terms: 'Weekdays', validityDays: 30 }, status: 201 }), 'Offer saved as a draft', ['offer']).offer;
  keys(draft, OFFER_KEYS, 'offer');
  assert.equal(draft.status, 'draft');
  const edited = ok(await call('PATCH', '/api/seller/offers/:id', { params: { id: draft._id }, headers: ctx.managerH, body: { terms: 'One per visit' } }), 'Offer saved', ['offer']).offer;
  assert.equal(edited.terms, 'One per visit');
  const submitted = ok(await call('POST', '/api/seller/offers/:id/submit', { params: { id: draft._id }, headers: H }), 'Offer sent for review', ['offer']).offer;
  assert.equal(submitted.status, 'pending_review');
  const mine = ok(await call('GET', '/api/seller/offers', { headers: H }), 'Offers', ['offers']).offers;
  assert.equal(mine.length, 1);

  const review = ok(await call('GET', '/api/admin/coupon-offers', { headers: ctx.adminH }), 'Coupon offers', ['offers', 'total', 'page', 'pages', 'statusCounts']);
  const row = review.offers[0];
  keys(row, [...OFFER_KEYS, 'category', 'seller'], 'admin offer');
  assert.equal(row.seller.businessName, 'Glow Salon');
  const approved = ok(await call('PATCH', '/api/admin/coupon-offers/:id/approve', { params: { id: draft._id }, headers: ctx.adminH, body: { updatedAt: row.updatedAt } }), 'Offer approved', ['offer']).offer;
  assert.equal(approved.status, 'approved');
  ctx.offerId = draft._id;

  const paused = ok(await call('POST', '/api/seller/offers/:id/pause', { params: { id: draft._id }, headers: H }), 'Offer paused', ['offer']).offer;
  assert.equal(paused.status, 'paused');
  const resumed = ok(await call('POST', '/api/seller/offers/:id/resume', { params: { id: draft._id }, headers: H }), 'Offer running again', ['offer']).offer;
  assert.equal(resumed.status, 'approved');

  const second = (await srv.request('POST', '/api/seller/offers', { headers: H, body: { title: 'FREE HAIRCUT FOREVER' } })).body.data.offer;
  await srv.request('POST', `/api/seller/offers/${second._id}/submit`, { headers: H });
  const rejected = ok(await call('PATCH', '/api/admin/coupon-offers/:id/reject', { params: { id: second._id }, headers: ctx.adminH, body: { reason: 'Offers must be honest' } }), 'Offer rejected', ['offer']).offer;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'Offers must be honest');
});

// ── 7. Customer: profile, payment, coupons ────────────────────────────────────

test('customer: gender and date of birth; a paid order earns a coupon; My Coupons list and detail; bill payment status', async () => {
  const profile = ok(await call('PATCH', '/api/users/me', { headers: ctx.customerH, body: { gender: 'female', dateOfBirth: '1995-04-12' } }), 'Profile updated', ['user']).user;
  assert.equal(profile.gender, 'female');
  assert.equal(profile.dateOfBirth, '1995-04-12T00:00:00.000Z');
  called.delete('PATCH /api/users/me'); // not a coupon route — checked here, not counted

  const order = await createPendingOnlineOrder(ctx.base);
  fake.addPayment({ id: 'pay_order_1', order_id: order.paymentIntentId, amount: order.paymentAmountPaise });
  await srv.request('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: ctx.customerH,
    body: { razorpay_payment_id: 'pay_order_1', razorpay_order_id: order.paymentIntentId, razorpay_signature: checkoutSignature(order.paymentIntentId, 'pay_order_1') },
  });
  await issue.settleScheduledIssues();
  const orderView = (await srv.get(`/api/orders/${order._id}`, ctx.customerH)).body.data.order;
  keys(orderView.couponsEarned, ['count', 'ids'], 'couponsEarned');
  assert.equal(orderView.couponsEarned.count, 1);

  const list = ok(await call('GET', '/api/users/me/coupons', { headers: ctx.customerH }), 'Coupons', ['coupons', 'total', 'page', 'limit']);
  assert.equal(list.total, 1);
  const c = list.coupons[0];
  keys(c, ['id', 'code', 'qrPayload', 'title', 'terms', 'seller', 'category', 'issuedAt', 'expiresAt', 'status', 'redeemedAt', 'voidedAt', 'source'], 'my coupon');
  keys(c.seller, ['id', 'name', 'address', 'phone', 'location'], 'coupon seller');
  assert.equal(c.qrPayload, c.code);
  assert.equal(c.title, '20% off any haircut');
  assert.equal(c.terms, 'One per visit');
  assert.equal(c.seller.name, 'Glow Salon');
  assert.equal(Math.round((new Date(c.expiresAt) - new Date(c.issuedAt)) / 86_400_000), 30);
  ctx.couponCode = c.code;
  ctx.couponId = c.id;
  const detail = ok(await call('GET', '/api/users/me/coupons/:id', { params: { id: c.id }, headers: ctx.customerH }), 'Coupon', ['coupon']).coupon;
  assert.deepEqual(detail, c);

  // A dine-in bill paid online: the payment status carries couponsEarned.
  const table = await Table.create({ restaurantId: ctx.base.restaurant._id, identifier: 'T1' });
  const session = await TableSession.create({ restaurantId: ctx.base.restaurant._id, tableId: table._id, guestName: 'Asha' });
  const round = await Order.create({
    restaurantId: ctx.base.restaurant._id, tableSessionId: session._id, tableId: table._id, userId: ctx.base.customer._id,
    type: 'dine_in', placedBy: 'guest', items: [{ menuItemId: ctx.base.dish._id, name: 'Thali', price: 300, quantity: 1 }], subtotal: 300, status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: round._id } });
  const billBase = `/api/restaurants/${ctx.base.restaurant._id}/tables/${table._id}/bill`;
  const { razorpayOrder } = (await srv.request('POST', `${billBase}/pay`)).body.data;
  fake.addPayment({ id: 'pay_bill_1', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  await srv.request('POST', `${billBase}/verify`, { body: { razorpay_payment_id: 'pay_bill_1', razorpay_order_id: razorpayOrder.id, razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_bill_1') } });
  await issue.settleScheduledIssues();
  const poll = (await srv.get(`${billBase}/payment?razorpayOrderId=${razorpayOrder.id}`, ctx.customerH)).body.data.bill;
  assert.equal(poll.couponsEarned.count, 1);
  assert.equal(poll.couponsEarned.ids.length, 1);
  assert.deepEqual((await srv.get(`${billBase}/payment?razorpayOrderId=${razorpayOrder.id}`)).body.data.bill.couponsEarned.ids, [], 'no ids for strangers');
});

// ── 8. Redemption ─────────────────────────────────────────────────────────────

test('redemption: lookup, redeem, a second redeem, today', async () => {
  const H = ctx.managerH;
  const look = ok(await call('POST', '/api/seller/redeem/lookup', { headers: H, body: { code: ctx.couponCode.toLowerCase() } }), 'Coupon', ['coupon']).coupon;
  keys(look, ['code', 'offerTitle', 'terms', 'category', 'customerFirstName', 'issuedAt', 'expiresAt', 'status', 'needsPhoneCheck'], 'lookup');
  assert.deepEqual([look.status, look.customerFirstName, look.category, look.needsPhoneCheck], ['issued', 'Asha', 'Salon', false]);

  const redeemed = ok(await call('POST', '/api/seller/redeem', { headers: H, body: { code: ctx.couponCode, phoneLast4: '3210' } }), 'Coupon redeemed', ['coupon']).coupon;
  keys(redeemed, ['code', 'offerTitle', 'terms', 'category', 'customerFirstName', 'issuedAt', 'expiresAt', 'status', 'needsPhoneCheck', 'redeemedAt', 'redeemedByName'], 'redeemed');
  assert.deepEqual([redeemed.status, redeemed.redeemedByName], ['redeemed', 'Meera Nair']);
  const again = err(await srv.request('POST', '/api/seller/redeem', { headers: H, body: { code: ctx.couponCode } }), 'COUPON_ALREADY_REDEEMED');
  keys(again.details, ['redeemedAt', 'redeemedByName'], 'already-redeemed details');

  const today = ok(await call('GET', '/api/seller/redeem/today', { headers: ctx.ownerH }), "Today's redemptions", ['scope', 'count', 'redemptions']);
  assert.deepEqual([today.scope, today.count], ['business', 1]);
  keys(today.redemptions[0], ['code', 'offerTitle', 'category', 'customerFirstName', 'redeemedAt', 'redeemedByName'], 'today row');
});

// ── 9. Dashboard and reports ──────────────────────────────────────────────────

test('dashboard and reports: numbers, rows and CSV', async () => {
  const H = ctx.ownerH;
  const safe = { customerPhones: [ctx.base.customer.phone], customerIds: [String(ctx.base.customer._id)] };
  const dash = ok(await call('GET', '/api/seller/dashboard', { headers: H }), 'Dashboard', ['plans', 'currentPlan', 'activePlans', 'stock', 'coupons', 'redemptionRate', 'recentCoupons']);
  assert.deepEqual(dash.stock, { allocated: 250, issued: 2, pending: 248 });
  assert.deepEqual(dash.coupons, { issued: 2, active: 1, redeemed: 1, expired: 0, void: 0, redemptionRate: 50 });
  keys(dash.recentCoupons[0], SELLER_COUPON_ROW, 'seller coupon row');
  fx.assertSellerSafe(dash, { ...safe, label: 'dashboard' });

  const demo = ok(await call('GET', '/api/seller/reports/demographics', { headers: H }), 'Demographics', ['filters', 'total', 'counts', 'gender', 'ageBands']);
  assert.deepEqual(demo.gender, { male: 0, female: 2, other: 0, not_given: 0 });
  assert.equal(demo.ageBands['25-34'], 2);
  keys(demo.counts, COUNTS, 'counts');

  const trends = ok(await call('GET', '/api/seller/reports/trends', { headers: H }), 'Trends', ['interval', 'from', 'to', 'status', 'series', 'totals']);
  assert.equal(trends.series.length, 30);
  for (const [interval, n] of [['week', 12], ['month', 12]]) {
    const t = (await srv.get(`/api/seller/reports/trends?interval=${interval}`, H)).body.data;
    assert.equal(t.series.length, n, `default ${interval} chart has ${n} whole buckets`);
  }
  assert.deepEqual(trends.totals, { issued: 2, redeemed: 1 });
  keys(trends.series[0], ['bucket', 'issued', 'redeemed'], 'trend bucket');

  const rows = ok(await call('GET', '/api/seller/reports/coupons', { headers: H }), 'Coupons', ['filters', 'coupons', 'total', 'page', 'limit']);
  assert.equal(rows.total, 2);
  assert.deepEqual(rows.coupons.map((r) => r.status).sort(), ['issued', 'redeemed']);
  assert.equal(rows.coupons.find((r) => r.status === 'redeemed').redeemedByName, 'Meera Nair');
  fx.assertSellerSafe(rows, { ...safe, label: 'coupon rows' });

  const csv = await call('GET', '/api/seller/reports/coupons.csv', { headers: H, raw: true });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '"Customer","Gender","Age band","Offer","Category","Issued (IST)","Expires (IST)","Status","Redeemed (IST)","Redeemed by"');
  assert.equal(lines.length, 3);
  fx.assertSellerSafe(csv.body, { ...safe, label: 'csv' });
});

// ── 10. Team, profile, agreement ──────────────────────────────────────────────

test('team: list, add, edit, remove', async () => {
  const H = ctx.ownerH;
  const team = ok(await call('GET', '/api/seller/users', { headers: H }), 'Team', ['members', 'manageableRoles']);
  keys(team.members[0], MEMBER_KEYS, 'member');
  assert.deepEqual(team.members.map((m) => [m.role, m.isYou, m.canManage]), [['owner', true, false], ['manager', false, true]]);
  assert.deepEqual(team.manageableRoles, ['owner', 'manager', 'employee']);

  const added = ok(await call('POST', '/api/seller/users', { headers: ctx.managerH, body: { name: 'Ravi Kumar', phone: '9700000002', role: 'employee' }, status: 201 }), 'Team member added', ['member']).member;
  keys(added, MEMBER_KEYS, 'member');
  const edited = ok(await call('PATCH', '/api/seller/users/:id', { params: { id: added._id }, headers: H, body: { experienceYears: 3 } }), 'Team member updated', ['member']).member;
  assert.equal(edited.experienceYears, 3);
  const removed = ok(await call('DELETE', '/api/seller/users/:id', { params: { id: added._id }, headers: H }), 'Team member removed', ['member']).member;
  assert.equal(removed.isActive, false);
});

test('profile and agreement: view, edit contact details; publish, read and accept the agreement', async () => {
  const H = ctx.ownerH;
  const profile = ok(await call('GET', '/api/seller/profile', { headers: ctx.managerH }), 'Profile', ['profile']).profile;
  keys(profile, ['_id', 'status', 'businessName', 'category', 'gstNumber', 'establishedOn', 'address', 'location', 'businessPhone', 'owner', 'approvedAt', 'currentPlan', 'activePlans', 'agreement', 'editableFields'], 'profile');
  assert.equal(profile.owner.panMasked, '******234F');
  const saved = ok(await call('PATCH', '/api/seller/profile', { headers: H, body: { businessPhone: '9844444444' } }), 'Profile updated', ['profile']).profile;
  assert.equal(saved.businessPhone, '9844444444');
  err(await srv.request('PATCH', '/api/seller/profile', { headers: H, body: { businessName: 'New' } }), 'PROFILE_LOCKED');

  const settings = ok(await call('PUT', '/api/admin/coupon-settings', { headers: ctx.adminH, body: { agreementVersion: 1, agreementText: 'Partner terms v1', note: 'First agreement' } }), 'Coupon settings saved', ['version', 'changes']);
  assert.deepEqual(settings.changes.map((c) => c.field).sort(), ['agreementText', 'agreementVersion']);
  assert.equal(settings.version.version, 2);

  const agreement = ok(await call('GET', '/api/seller/agreement', { headers: ctx.managerH }), 'Agreement', ['agreement']).agreement;
  assert.deepEqual(agreement, { published: true, version: 1, text: 'Partner terms v1', acceptance: null, upToDate: false });
  const accepted = ok(await call('POST', '/api/seller/agreement/accept', { headers: H, body: { version: 1 } }), 'Agreement accepted', ['agreement']).agreement;
  assert.equal(accepted.upToDate, true);
  keys(accepted.acceptance, ['version', 'acceptedAt', 'acceptedByName'], 'acceptance');
  assert.equal(accepted.acceptance.acceptedByName, 'Asha Rao');
});

// ── 11. SMS credits and reminders ─────────────────────────────────────────────

test('SMS credits and reminders: shop, buy (verify), simulate off, reminders screen', async () => {
  const H = ctx.ownerH;
  const shop = ok(await call('GET', '/api/seller/sms-credits', { headers: ctx.managerH }), 'SMS credits', ['balance', 'perSms', 'packs', 'available', 'purchases']);
  assert.equal(shop.balance, 50);
  assert.equal(shop.perSms.totalPaise, 354);
  assert.deepEqual(shop.packs.map((p) => [p.credits, p.totalPaise]), [[100, 35_400], [500, 177_000], [1000, 354_000]]);

  const started = ok(await call('POST', '/api/seller/sms-credits/purchase', { headers: H, body: { credits: 100 }, status: 201 }), 'Purchase started', ['purchase', 'razorpayOrder', 'paymentSimulated']);
  assert.equal(started.razorpayOrder.amount, 35_400);
  fake.addPayment({ id: 'pay_sms_1', order_id: started.razorpayOrder.id, amount: 35_400 });
  const paid = ok(await call('POST', '/api/seller/sms-credits/purchase/:id/verify', {
    params: { id: started.purchase._id },
    headers: H,
    body: { razorpay_order_id: started.razorpayOrder.id, razorpay_payment_id: 'pay_sms_1', razorpay_signature: checkoutSignature(started.razorpayOrder.id, 'pay_sms_1') },
  }), 'Credits added', ['purchase']).purchase;
  assert.equal(paid.status, 'paid');
  err(await call('POST', '/api/seller/sms-credits/purchase/:id/simulate-payment', { params: { id: started.purchase._id }, headers: H, status: 404 }), 'NOT_FOUND');
  assert.equal((await srv.get('/api/seller/sms-credits', H)).body.data.balance, 150);

  const reminders = ok(await call('GET', '/api/seller/reminders', { headers: H }), 'Reminders', ['credits', 'reminderLeadDays', 'perSms', 'expiringSoon', 'sent']);
  assert.deepEqual([reminders.credits, reminders.reminderLeadDays, reminders.expiringSoon.length, reminders.sent.length], [150, 3, 0, 0]);
});

// ── 12. Admin: coupons ────────────────────────────────────────────────────────

test('admin coupons: list, CSV export, complimentary list / assign / mark used, manual issue', async () => {
  const H = ctx.adminH;
  const list = ok(await call('GET', '/api/admin/coupons?kind=customer', { headers: H }), 'Coupons', ['coupons', 'total', 'page', 'limit', 'sort', 'filters']);
  assert.equal(list.total, 2);
  keys(list.coupons[0], ADMIN_ROW, 'admin row');
  assert.ok(list.coupons.every((r) => r.mobile === ctx.base.customer.phone && r.age === 31));

  const csv = await call('GET', '/api/admin/coupons/export.csv', { headers: H, raw: true });
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Code,Kind,Customer,Mobile,Age,Gender,Category,Seller,Seller ID,Offer,Issued (IST),Expires (IST),Status,Redeemed (IST),Redeemed by');
  assert.equal(lines.length, 1 + 2 + 10, '2 customer + 10 complimentary coupons');
  assert.ok(csv.body.includes(ctx.base.customer.phone));

  const comp = ok(await call('GET', '/api/admin/coupons/complimentary', { headers: H }), 'Complimentary coupons', ['groups', 'total']);
  assert.equal(comp.total, 10);
  keys(comp.groups[0], ['subscriptionId', 'seller', 'plan', 'activatedAt', 'coupons'], 'complimentary group');
  const target = comp.groups[0].coupons[0];
  keys(target, ['id', 'code', 'status', 'expiresAt', 'redeemedAt', 'assignedTo'], 'complimentary coupon');
  const assigned = ok(await call('PATCH', '/api/admin/coupons/complimentary/:id/assign', { params: { id: target.id }, headers: H, body: { name: 'Sana Khan', phone: '9900000001', note: 'Launch' } }), 'Coupon assigned', ['coupon']).coupon;
  keys(assigned.assignedTo, ['name', 'phone', 'note', 'at'], 'assignedTo');
  const used = ok(await call('PATCH', '/api/admin/coupons/complimentary/:id/mark-used', { params: { id: target.id }, headers: H }), 'Coupon marked used', ['coupon']).coupon;
  assert.equal(used.status, 'redeemed');

  const issued = ok(await call('POST', '/api/admin/coupons/issue', { headers: H, body: { phone: ctx.base.customer.phone, sellerId: ctx.sellerId, note: 'Goodwill', requestId: 'req-goodwill-1' }, status: 201 }), 'Coupon issued', ['coupon', 'duplicate']);
  assert.equal(issued.duplicate, false);
  keys(issued.coupon, ADMIN_ROW, 'issued coupon');
  assert.equal(issued.coupon.source, 'manual');
});

// ── 13. Admin: reports, settings, campaigns ───────────────────────────────────

test('admin reports: summary, by category, by seller, demographics, trends, employees, sellers', async () => {
  const H = ctx.adminH;
  const summary = ok(await call('GET', '/api/admin/coupon-reports/summary', { headers: H }), 'Coupon report', ['filters', ...COUNTS, 'pending', 'stock', 'complimentary']);
  assert.deepEqual([summary.issued, summary.redeemed, summary.active, summary.pending], [3, 1, 2, 247 + 900]);
  assert.deepEqual(summary.complimentary, { total: 10, assigned: 1, used: 1, expired: 0, unused: 9 });

  const byCat = ok(await call('GET', '/api/admin/coupon-reports/by-category', { headers: H }), 'Coupon report', ['filters', 'categories']).categories;
  keys(byCat[0], ['id', 'key', 'name', 'enabled', ...COUNTS], 'category row');
  assert.equal(byCat.find((c) => c.key === 'salon').issued, 3);

  const bySeller = ok(await call('GET', '/api/admin/coupon-reports/by-seller', { headers: H }), 'Coupon report', ['filters', 'sellers']).sellers;
  keys(bySeller[0], ['id', 'name', 'status', ...COUNTS], 'seller row');
  assert.deepEqual(bySeller.map((s) => [s.name, s.issued]), [['Glow Salon', 3]]);

  const demo = ok(await call('GET', '/api/admin/coupon-reports/demographics', { headers: H }), 'Coupon report', ['filters', 'total', 'counts', 'gender', 'ageBands']);
  assert.equal(demo.gender.female, 3);

  const trends = ok(await call('GET', '/api/admin/coupon-reports/trends?interval=month', { headers: H }), 'Coupon report', ['interval', 'from', 'to', 'status', 'series', 'totals']);
  assert.equal(trends.series.length, 12);
  assert.deepEqual(trends.totals, { issued: 3, redeemed: 1 });

  const employees = ok(await call('GET', '/api/admin/coupon-reports/employees', { headers: H }), 'Coupon report', ['filters', 'employees']).employees;
  const meera = employees.find((e) => e.name === 'Meera Nair' && e.role === 'manager');
  keys(meera, ['id', 'seller', 'name', 'role', 'phone', 'status', 'redemptions', 'lastRedemptionAt'], 'employee row');
  assert.deepEqual([meera.phone, meera.redemptions], [MANAGER_PHONE, 1]);
  assert.equal(employees.find((e) => e.name === 'Ravi Kumar').status, 'removed');

  const sellers = ok(await call('GET', '/api/admin/coupon-reports/sellers', { headers: H }), 'Coupon report', ['filters', 'sellers']).sellers;
  const glow = sellers.find((s) => s.businessName === 'Glow Salon');
  keys(glow, ['id', 'businessName', 'category', 'status', 'city', 'businessPhone', 'ownerName', 'approvedAt', 'currentPlan', 'activePlans', 'allocated', 'issued', 'pending', 'redeemed', 'expired', 'void', 'redemptionRate'], 'sellers report row');
  assert.deepEqual([glow.allocated, glow.issued, glow.pending, glow.redeemed], [250, 3, 247, 1]);
});

test('admin settings and reminder campaigns: read settings; preview, create, list, detail', async () => {
  const H = ctx.adminH;
  const settings = ok(await call('GET', '/api/admin/coupon-settings', { headers: H }), 'Coupon settings', ['active', 'versions', 'units']);
  assert.equal(settings.active.version, 2);
  assert.deepEqual(settings.versions.map((v) => v.version), [2, 1]);
  assert.ok('phoneCheckRequired' in settings.units);

  const window = { seller: ctx.sellerId, expiringTo: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) };
  const preview = ok(await call('POST', '/api/admin/reminder-campaigns/preview', { headers: H, body: window }), 'Campaign preview', ['filters', 'recipientCount', 'perSms', 'cost']);
  assert.equal(preview.recipientCount, 2, 'the bill coupon and the manual one (the order coupon is redeemed)');
  assert.deepEqual(preview.cost, { pricePaise: 600, gstPaise: 108, totalPaise: 708, total: 7.08 });

  const created = ok(await call('POST', '/api/admin/reminder-campaigns', { headers: H, body: window, status: 201 }), 'Campaign queued', ['campaign']).campaign;
  keys(created, ['_id', 'status', 'filters', 'recipientCount', 'cost', 'counts', 'createdBy', 'sellerId', 'createdAt', 'startedAt', 'finishedAt'], 'campaign');
  assert.deepEqual([created.status, created.createdBy, created.cost.totalPaise], ['queued', 'admin', 708]);

  const list = ok(await call('GET', '/api/admin/reminder-campaigns', { headers: H }), 'Campaigns', ['campaigns', 'total', 'page', 'limit']);
  assert.equal(list.total, 1);
  const detail = ok(await call('GET', '/api/admin/reminder-campaigns/:id', { params: { id: created._id }, headers: H }), 'Campaign', ['campaign', 'logCounts', 'log', 'total', 'page', 'limit']);
  assert.deepEqual(detail.logCounts, { queued: 0, sent: 0, failed: 0 });
});

// ── 14. Logout, then coverage ─────────────────────────────────────────────────

test('logout ends the session', async () => {
  ok(await call('POST', '/api/seller/auth/logout', { headers: ctx.ownerH }), 'Logged out', null);
  const after = await srv.request('GET', '/api/seller/auth/me', { headers: ctx.ownerH });
  assert.equal(after.status, 401);
  err(after, 'INVALID_TOKEN');
});

test('every mounted coupon route was called above with a checked response', () => {
  const mounted = mountedRoutes(app, COUPON_ROUTE_SCOPE);
  assert.ok(mounted.length >= 90);
  const missed = mounted.filter((r) => !called.has(r));
  assert.deepEqual(missed, [], `routes without a response check:\n${missed.join('\n')}`);
  const unknown = [...called].filter((r) => !mounted.includes(r));
  assert.deepEqual(unknown, [], `called patterns that are not mounted routes:\n${unknown.join('\n')}`);
});
