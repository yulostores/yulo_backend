// CB8 — the seller dashboard and reports against a seeded fixture whose every number is known:
// status counts, redemption rate, gender, age bands (at issue), IST trend buckets, the paged list
// and the CSV. Then the visibility sweep: every seller endpoint response is walked for customer
// phones / ids and complimentary coupons; cross-seller isolation; employees refused everywhere
// but redemption. In-memory MongoDB, in-memory Redis stand-in; everything through HTTP.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller, sellerHeaders, assertSellerSafe } = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { bucketOf } = await import('../services/sellerReports.service.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let fx; // the fixture

before(async () => {
  mongo = await startMemoryMongo();
  await Coupon.init();
  auth.__setAuthRedisForTests(redis);
  redemption.__setRedeemRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  auth.__setAuthRedisForTests(undefined);
  redemption.__setRedeemRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  __resetCouponSettingsCache();
  fx = await seedFixture();
});

const FAR = new Date('2099-01-01T00:00:00Z');

const subscription = (sellerId, { allocated, issued, reference = `NEFT-${sellerId}` }) =>
  SellerSubscription.create({
    sellerId,
    planSnapshot: {
      planId: new mongoose.Types.ObjectId(),
      key: 'basic',
      name: 'Basic',
      basePricePaise: 500_000,
      gstPercent: 18,
      gstPaise: 90_000,
      totalPaise: 590_000,
      couponAllocation: allocated,
      complimentaryCount: 5,
    },
    status: 'active',
    payment: { method: 'manual', amountPaise: 590_000, manual: { mode: 'neft', reference } },
    allocated,
    issued,
    remaining: allocated - issued,
    activatedAt: new Date('2026-02-20T00:00:00Z'),
  });

/**
 * Seller A ("Glow Salon"): six customer coupons with known people, dates and outcomes, one
 * complimentary coupon. Seller B: one coupon of its own. Customers have real phone numbers, so the
 * sweep can look for them.
 */
const seedFixture = async () => {
  const category = await makeCategory({ key: 'salon', name: 'Salon', enabled: true });
  const a = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000001' });
  const b = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000002' });
  await SellerUser.updateOne({ _id: b.owner._id }, { $set: { name: 'Other Owner' } });
  const manager = await SellerUser.create({ sellerId: a.seller._id, name: 'Meera Nair', phone: '9700000001', role: 'manager' });
  const employee = await SellerUser.create({ sellerId: a.seller._id, name: 'Ravi Kumar', phone: '9700000002', role: 'employee' });
  const subA = await subscription(a.seller._id, { allocated: 250, issued: 5 });
  const subB = await subscription(b.seller._id, { allocated: 250, issued: 1 });
  const offerA = await CouponOffer.create({ sellerId: a.seller._id, categoryId: category._id, title: '20% off any haircut', status: 'approved' });

  const customers = await User.create([
    { name: 'Priya Sharma', phone: '9811100001', role: 'customer' },
    { name: 'Rahul Verma', phone: '9811100002', role: 'customer' },
    { name: 'Anita', phone: '9811100003', role: 'customer' },
    { name: 'Nameless', phone: '9811100004', role: 'customer' },
    { name: 'Kiran Rao', phone: '9811100005', role: 'customer' },
    { name: 'Vikram Singh', phone: '9811100006', role: 'customer' },
  ]);

  const make = (sellerId, subscriptionId, customer, over) =>
    Coupon.create({
      code: generateCouponCode(),
      kind: 'customer',
      sellerId,
      subscriptionId,
      offerId: offerA._id,
      offerSnapshot: { title: '20% off any haircut', terms: '' },
      categoryId: category._id,
      customerId: customer?._id ?? null,
      source: { type: 'order', id: new mongoose.Types.ObjectId() },
      ...over,
    });
  const snap = (name, gender, dob) => ({ name, gender, dateOfBirth: dob ? new Date(dob) : null });

  const c = [];
  // 1. 00:10 IST on 2 Mar (still 1 Mar in UTC) — active. Turns 32 that day → 25-34.
  c.push(await make(a.seller._id, subA._id, customers[0], {
    customerSnapshot: snap('Priya Sharma', 'female', '1994-03-02'),
    issuedAt: new Date('2026-03-01T18:40:00Z'),
    expiresAt: FAR,
  }));
  // 2. 23:50 IST on 1 Mar — redeemed 10:30 IST on 3 Mar by the employee. 26 → 25-34.
  c.push(await make(a.seller._id, subA._id, customers[1], {
    customerSnapshot: snap('Rahul Verma', 'male', '2000-01-10'),
    issuedAt: new Date('2026-03-01T18:20:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-03-03T05:00:00Z'),
    redeemedBy: employee._id,
  }));
  // 3. 10 Mar — past its date but the expiry job hasn't run (still 'issued'). 16 → under-18.
  c.push(await make(a.seller._id, subA._id, customers[2], {
    customerSnapshot: snap('Anita', 'female', '2009-05-05'),
    issuedAt: new Date('2026-03-10T06:00:00Z'),
    expiresAt: new Date('2026-04-09T06:00:00Z'),
  }));
  // 4. 5 Apr — marked expired; no gender or date of birth; a name that looks like a formula.
  c.push(await make(a.seller._id, subA._id, customers[3], {
    customerSnapshot: snap('=HYPERLINK("http://x")', null, null),
    issuedAt: new Date('2026-04-05T06:00:00Z'),
    expiresAt: new Date('2026-05-05T06:00:00Z'),
    status: 'expired',
  }));
  // 5. 20 Apr — void (refunded). 66 → 55+.
  c.push(await make(a.seller._id, subA._id, customers[4], {
    customerSnapshot: snap('Kiran Rao', 'other', '1960-01-01'),
    issuedAt: new Date('2026-04-20T06:00:00Z'),
    expiresAt: FAR,
    status: 'void',
    voidedAt: new Date('2026-04-21T06:00:00Z'),
  }));
  // 6. 21 Apr — redeemed next day by the owner. 40 → 35-44.
  c.push(await make(a.seller._id, subA._id, customers[5], {
    customerSnapshot: snap('Vikram Singh', 'male', '1985-06-15'),
    issuedAt: new Date('2026-04-21T06:00:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-04-22T10:00:00Z'),
    redeemedBy: a.owner._id,
  }));

  // Never counted for anyone: a complimentary coupon of A's, and B's own coupon.
  await Coupon.create({
    code: generateCouponCode(),
    kind: 'complimentary',
    sellerId: a.seller._id,
    subscriptionId: subA._id,
    categoryId: category._id,
    source: { type: 'plan', id: subA._id },
    issuedAt: new Date('2026-03-05T06:00:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-03-06T06:00:00Z'),
  });
  const bCoupon = await make(b.seller._id, subB._id, customers[0], {
    customerSnapshot: snap('Priya Sharma', 'female', '1994-03-02'),
    issuedAt: new Date('2026-03-05T06:00:00Z'),
    expiresAt: FAR,
  });

  return {
    category,
    a,
    b,
    manager: { user: manager, headers: sellerHeaders(manager) },
    employee: { user: employee, headers: sellerHeaders(employee) },
    coupons: c,
    bCoupon,
    safe: {
      customerPhones: customers.map((u) => u.phone),
      customerIds: customers.map((u) => String(u._id)),
    },
  };
};

const get = async (path, headers = fx.a.headers) => {
  const res = await srv.get(`/api/seller${path}`, headers);
  if (res.status === 200) assertSellerSafe(res.body, { ...fx.safe, label: `GET ${path}` });
  return res;
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

// CF10 browser run: after buying Basic and then Plus, every screen said "Basic plan" (currentPlan is
// the plan stock is drawn from first). activePlans names them all, oldest first.
test('dashboard: two plans bought — activePlans lists both, oldest first; currentPlan stays the first', async () => {
  const plus = await subscription(fx.a.seller._id, { allocated: 900, issued: 0, reference: 'NEFT-PLUS-2' });
  await SellerSubscription.updateOne(
    { _id: plus._id },
    { $set: { 'planSnapshot.key': 'plus', 'planSnapshot.name': 'Plus', activatedAt: new Date('2026-03-05T00:00:00Z') } },
  );
  const d = (await get('/dashboard')).body.data;
  assert.deepEqual(d.activePlans, [
    { key: 'basic', name: 'Basic' },
    { key: 'plus', name: 'Plus' },
  ]);
  assert.equal(d.currentPlan.plan.name, 'Basic');
  assert.deepEqual(d.stock, { allocated: 1150, issued: 5, pending: 1145 });
  const subs = (await get('/subscriptions')).body.data;
  assert.deepEqual(subs.activePlans.map((p) => p.name), ['Basic', 'Plus']);
});

test('dashboard: stock, counts, redemption rate and the last coupons — own customer coupons only', async () => {
  const res = await get('/dashboard');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.deepEqual(d.stock, { allocated: 250, issued: 5, pending: 245 });
  assert.deepEqual(d.coupons, { issued: 5, active: 1, redeemed: 2, expired: 2, void: 1, redemptionRate: 40 });
  assert.equal(d.redemptionRate, 40);
  assert.equal(d.plans.length, 1);
  assert.equal(d.plans[0].plan.name, 'Basic');
  assert.equal(d.recentCoupons.length, 6, 'the complimentary coupon is not one of them');
  assert.equal(d.recentCoupons[0].id, String(fx.coupons[5]._id), 'newest first');
  assert.deepEqual(Object.keys(d.recentCoupons[0]).sort(), [
    'ageBand', 'category', 'customerName', 'expiresAt', 'gender', 'id', 'issuedAt', 'offerTitle', 'redeemedAt', 'redeemedByName', 'status',
  ]);
  assert.equal(d.recentCoupons[0].customerName, 'Vikram S.');
  assert.equal(d.recentCoupons[0].redeemedByName, 'Asha Rao');
  assert.ok(!JSON.stringify(d).includes(fx.coupons[0].code), 'no coupon codes in reports');

  // The manager sees the same; seller B sees only its own.
  assert.deepEqual((await get('/dashboard', fx.manager.headers)).body.data.coupons, d.coupons);
  const other = (await get('/dashboard', fx.b.headers)).body.data;
  assert.deepEqual(other.coupons, { issued: 1, active: 1, redeemed: 0, expired: 0, void: 0, redemptionRate: 0 });
  assert.equal(other.recentCoupons.length, 1);
});

// ── Demographics ──────────────────────────────────────────────────────────────

test('demographics: gender and age bands (as at issue) match the fixture; filters by IST date and status', async () => {
  const all = (await get('/reports/demographics')).body.data;
  assert.equal(all.total, 6);
  assert.deepEqual(all.gender, { male: 2, female: 2, other: 1, not_given: 1 });
  assert.deepEqual(all.ageBands, { 'under-18': 1, '18-24': 0, '25-34': 2, '35-44': 1, '45-54': 0, '55+': 1, 'not-given': 1 });
  assert.equal(all.counts.redemptionRate, 40);

  // 2 Mar–31 Mar in India: coupon 1 (00:10 IST on 2 Mar) is in, coupon 2 (23:50 IST on 1 Mar) is out.
  const march = (await get('/reports/demographics?from=2026-03-02&to=2026-03-31')).body.data;
  assert.equal(march.total, 2);
  assert.deepEqual(march.gender, { male: 0, female: 2, other: 0, not_given: 0 });

  const redeemed = (await get('/reports/demographics?status=redeemed')).body.data;
  assert.equal(redeemed.total, 2);
  assert.deepEqual(redeemed.gender, { male: 2, female: 0, other: 0, not_given: 0 });
  // 'expired' includes the one past its date that the job hasn't marked yet.
  assert.equal((await get('/reports/demographics?status=expired')).body.data.total, 2);
  assert.equal((await get('/reports/demographics?status=issued')).body.data.total, 1);

  for (const q of ['?from=2026-13-01', '?from=2026-04-02&to=2026-04-01', '?status=complimentary', '?from=yesterday']) {
    assert.equal((await get(`/reports/demographics${q}`)).status, 400, q);
  }
});

// ── Trends ────────────────────────────────────────────────────────────────────

test('trends: issued vs redeemed per IST day, Monday week and month, zero-filled', async () => {
  const day = (await get('/reports/trends?interval=day&from=2026-03-01&to=2026-03-03')).body.data;
  assert.deepEqual(day.series, [
    { bucket: '2026-03-01', issued: 1, redeemed: 0 },
    { bucket: '2026-03-02', issued: 1, redeemed: 0 },
    { bucket: '2026-03-03', issued: 0, redeemed: 1 },
  ]);

  // 1 Mar 2026 is a Sunday: it belongs to the week starting Monday 23 Feb.
  const week = (await get('/reports/trends?interval=week&from=2026-03-01&to=2026-03-14')).body.data;
  assert.deepEqual(week.series, [
    { bucket: '2026-02-23', issued: 1, redeemed: 0 },
    { bucket: '2026-03-02', issued: 1, redeemed: 1 },
    { bucket: '2026-03-09', issued: 1, redeemed: 0 },
  ]);

  const month = (await get('/reports/trends?interval=month&from=2026-03-01&to=2026-04-30')).body.data;
  assert.deepEqual(month.series, [
    { bucket: '2026-03', issued: 3, redeemed: 1 },
    { bucket: '2026-04', issued: 3, redeemed: 1 },
  ]);
  assert.deepEqual(month.totals, { issued: 6, redeemed: 2 });

  const onlyRedeemed = (await get('/reports/trends?interval=month&from=2026-03-01&to=2026-04-30&status=redeemed')).body.data;
  assert.deepEqual(onlyRedeemed.series.map((s) => s.issued), [1, 1]);

  // Default range: the last 30 IST days, ending today.
  const recent = (await get('/reports/trends')).body.data;
  assert.equal(recent.series.length, 30);
  assert.equal(recent.to, bucketOf(new Date(), 'day'));

  assert.equal((await get('/reports/trends?interval=hour')).status, 400);
  assert.equal((await get('/reports/trends?interval=day&from=2020-01-01&to=2026-01-01')).status, 400, 'too many daily buckets');
});

// ── Coupon list and CSV ───────────────────────────────────────────────────────

test('coupon list: paged, newest first, masked names, age bands, who redeemed — same rows as the CSV', async () => {
  const page1 = (await get('/reports/coupons?limit=4')).body.data;
  assert.equal(page1.total, 6);
  assert.equal(page1.coupons.length, 4);
  const page2 = (await get('/reports/coupons?limit=4&page=2')).body.data;
  assert.equal(page2.coupons.length, 2);
  const rows = [...page1.coupons, ...page2.coupons];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const rahul = byId.get(String(fx.coupons[1]._id));
  assert.equal(rahul.customerName, 'Rahul V.');
  assert.equal(rahul.gender, 'male');
  assert.equal(rahul.ageBand, '25-34');
  assert.equal(rahul.status, 'redeemed');
  assert.equal(rahul.redeemedByName, 'Ravi Kumar');
  assert.equal(byId.get(String(fx.coupons[2]._id)).status, 'expired', 'past its date reads as expired');
  assert.equal(byId.get(String(fx.coupons[2]._id)).customerName, 'Anita');
  assert.equal(byId.get(String(fx.coupons[0]._id)).ageBand, '25-34', 'age on the day it was issued');

  const filtered = (await get('/reports/coupons?status=void')).body.data;
  assert.deepEqual(filtered.coupons.map((r) => r.id), [String(fx.coupons[4]._id)]);

  const csv = await srv.get('/api/seller/reports/coupons.csv', fx.a.headers);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assertSellerSafe(csv.body, { ...fx.safe, label: 'coupons.csv' });
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '"Customer","Gender","Age band","Offer","Category","Issued (IST)","Expires (IST)","Status","Redeemed (IST)","Redeemed by"');
  assert.equal(lines.length, 7, 'header + 6 rows');
  assert.ok(lines.includes('"Rahul V.","Male","25-34","20% off any haircut","Salon","2026-03-01 23:50","2099-01-01 05:30","redeemed","2026-03-03 10:30","Ravi Kumar"'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('"\'=HYPERLINK(""http://x"")"')), 'formula neutralised');
  assert.ok(!/phone/i.test(lines[0]));
  // Readable for people: nothing blank or raw in the gender / age columns (CF10 browser run).
  for (const line of lines.slice(1)) {
    const [customer, gender, band] = line.slice(1, -1).split('","');
    assert.ok(customer.length > 0, `customer never blank: ${line}`);
    assert.ok(['Male', 'Female', 'Other', 'Not given'].includes(gender), line);
    assert.ok(band === 'Not given' || band === 'Under 18' || /^\d\d(-\d\d|\+)$/.test(band), line);
  }
  assert.ok(lines.some((l) => l.includes('"Not given","Not given"')), 'a customer who gave neither');
  const redeemedCsv = (await srv.get('/api/seller/reports/coupons.csv?status=redeemed', fx.a.headers)).body.trim().split('\r\n');
  assert.equal(redeemedCsv.length, 3);
});

// ── Visibility sweep ──────────────────────────────────────────────────────────

const SELLER_GETS = [
  '/auth/me',
  '/status',
  '/plans',
  '/subscriptions',
  '/offers',
  '/redeem/today',
  '/dashboard',
  '/reports/demographics',
  '/reports/trends?interval=month&from=2026-03-01&to=2026-04-30',
  '/reports/coupons?limit=100',
  '/users',
  '/profile',
  '/agreement',
];

test('every seller endpoint, for owner and manager: no customer phone or id, nothing complimentary', async () => {
  // Fill the "today" list and exercise lookup / redeem / refusal bodies too.
  const fresh = await Coupon.create({
    code: generateCouponCode(),
    kind: 'customer',
    sellerId: fx.a.seller._id,
    subscriptionId: new mongoose.Types.ObjectId(),
    offerSnapshot: { title: '20% off any haircut', terms: '' },
    categoryId: fx.category._id,
    customerId: fx.coupons[0].customerId,
    customerSnapshot: { name: 'Priya Sharma', gender: 'female', dateOfBirth: new Date('1994-03-02') },
    source: { type: 'order', id: new mongoose.Types.ObjectId() },
    expiresAt: FAR,
  });
  const complimentary = await Coupon.findOne({ kind: 'complimentary' }).lean();
  for (const headers of [fx.a.headers, fx.manager.headers]) {
    for (const [method, path, body] of [
      ['POST', '/redeem/lookup', { code: fresh.code }],
      ['POST', '/redeem/lookup', { code: complimentary.code }],
      ['POST', '/redeem', { code: fresh.code }],
      ['POST', '/redeem', { code: fx.coupons[1].code }],
    ]) {
      const res = await srv.request(method, `/api/seller${path}`, { body, headers });
      assertSellerSafe(res.body, { ...fx.safe, label: `${method} ${path}` });
    }
    for (const path of SELLER_GETS) {
      const res = await get(path, headers);
      // Plans, purchases and the agreement are the owner's alone.
      const ownerOnly = ['/plans', '/subscriptions', '/agreement'].includes(path);
      const expected = ownerOnly && headers === fx.manager.headers ? 403 : 200;
      assert.equal(res.status, expected, `${path}: ${JSON.stringify(res.body)}`);
      assertSellerSafe(res.body, { ...fx.safe, label: `GET ${path}` });
    }
  }
  const csv = await srv.get('/api/seller/reports/coupons.csv', fx.manager.headers);
  assertSellerSafe(csv.body, { ...fx.safe, label: 'csv' });
});

test('the leak checker itself catches each kind of leak', () => {
  const opts = { customerPhones: ['9811100001'], customerIds: ['abc123'] };
  assert.throws(() => assertSellerSafe({ a: { b: ['x', '+91 9811100001'] } }, opts), /phone/);
  assert.throws(() => assertSellerSafe({ customerId: null }, opts), /forbidden key/);
  assert.throws(() => assertSellerSafe({ rows: [{ kind: 'complimentary' }] }, opts), /complimentary/);
  assert.throws(() => assertSellerSafe({ complimentaryCount: 5 }, opts), /forbidden key/);
  assert.throws(() => assertSellerSafe({ owner: 'abc123' }, opts), /customer id/);
  assert.doesNotThrow(() => assertSellerSafe({ name: 'Priya S.', count: 5 }, opts));
});

// ── Isolation and roles ───────────────────────────────────────────────────────

test("cross-seller isolation: B's reports never include A's coupons, and A's ids are not found for B", async () => {
  const list = (await get('/reports/coupons', fx.b.headers)).body.data;
  assert.deepEqual(list.coupons.map((r) => r.id), [String(fx.bCoupon._id)]);
  assert.equal((await get('/reports/demographics', fx.b.headers)).body.data.total, 1);
  const bTrend = (await get('/reports/trends?interval=month&from=2026-03-01&to=2026-04-30', fx.b.headers)).body.data;
  assert.deepEqual(bTrend.totals, { issued: 1, redeemed: 0 });
  const bTeam = (await get('/users', fx.b.headers)).body.data.members;
  assert.deepEqual(bTeam.map((m) => m.name), ['Other Owner']);
  for (const [method, path] of [
    ['PATCH', `/users/${fx.employee.user._id}`],
    ['DELETE', `/users/${fx.employee.user._id}`],
  ]) {
    const res = await srv.request(method, `/api/seller${path}`, { body: method === 'PATCH' ? { name: 'Hijacked' } : undefined, headers: fx.b.headers });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await SellerUser.findById(fx.employee.user._id).lean()).name, 'Ravi Kumar');
  const bCsv = (await srv.get('/api/seller/reports/coupons.csv', fx.b.headers)).body.trim().split('\r\n');
  assert.equal(bCsv.length, 2);
});

test('an employee is refused (403) on every route except redemption', async () => {
  const h = fx.employee.headers;
  const refused = [
    ['GET', '/dashboard'],
    ['GET', '/reports/demographics'],
    ['GET', '/reports/trends'],
    ['GET', '/reports/coupons'],
    ['GET', '/reports/coupons.csv'],
    ['GET', '/users'],
    ['POST', '/users', { name: 'X Y', phone: '9700000099', role: 'employee' }],
    ['PATCH', `/users/${fx.manager.user._id}`, { name: 'X' }],
    ['DELETE', `/users/${fx.manager.user._id}`],
    ['GET', '/profile'],
    ['PATCH', '/profile', { businessPhone: '9811111112' }],
    ['GET', '/agreement'],
    ['POST', '/agreement/accept', { version: 1 }],
    ['GET', '/plans'],
    ['GET', '/subscriptions'],
    ['POST', '/subscriptions', { planKey: 'basic' }],
    ['GET', '/offers'],
    ['POST', '/offers', { title: 'Free' }],
    ['GET', '/onboarding'],
  ];
  for (const [method, path, body] of refused) {
    const res = await srv.request(method, `/api/seller${path}`, { body, headers: h });
    assert.equal(res.status, 403, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  // …and allowed to redeem.
  assert.equal((await srv.request('GET', '/api/seller/redeem/today', { headers: h })).status, 200);
  const look = await srv.request('POST', '/api/seller/redeem/lookup', { body: { code: fx.coupons[0].code }, headers: h });
  assert.equal(look.status, 200);
  assertSellerSafe(look.body, { ...fx.safe, label: 'employee lookup' });
});

test('a suspended seller is refused on the dashboard, reports and team', async () => {
  const { default: Seller } = await import('../models/Seller.js');
  await Seller.updateOne({ _id: fx.a.seller._id }, { $set: { status: 'suspended' } });
  for (const path of ['/dashboard', '/reports/coupons', '/users', '/profile']) {
    const res = await srv.get(`/api/seller${path}`, fx.a.headers);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, 'SELLER_NOT_ACTIVE');
  }
});
