// CB9 — the super admin's coupon tools against a fixture whose every number is known: the coupon
// list (every filter, search, sort, paging), the streamed CSV (header, formula-safe cells, audit
// row, rate limit), complimentary coupons (list, assign, mark used), manual issue (stock taken,
// audit, idempotent), every coupon report, versioned settings, and admin-only access.
// In-memory MongoDB; everything through HTTP.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller } = await import('../test-utils/sellerFixtures.mjs');
const { generateTokens } = await import('../services/auth.service.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { ADMIN_EXPORT_LIMIT } = await import('../middleware/rateLimiter.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: User } = await import('../models/User.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: CouponSettings } = await import('../models/CouponSettings.js');

let mongo;
let srv;
let fx;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Coupon.init(), CouponSettings.init()]);
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetCouponSettingsCache();
  fx = await seedFixture();
});

const FAR = new Date('2099-01-01T00:00:00Z');

const subscription = (sellerId, { key, allocated, issued }) =>
  SellerSubscription.create({
    sellerId,
    planSnapshot: {
      planId: new mongoose.Types.ObjectId(),
      key,
      name: key === 'basic' ? 'Basic' : 'Plus',
      basePricePaise: 500_000,
      gstPercent: 18,
      gstPaise: 90_000,
      totalPaise: 590_000,
      couponAllocation: allocated,
      complimentaryCount: 5,
    },
    status: 'active',
    payment: { method: 'manual', amountPaise: 590_000, manual: { mode: 'neft', reference: `NEFT-${sellerId}` } },
    allocated,
    issued,
    remaining: allocated - issued,
    activatedAt: new Date('2026-02-20T00:00:00Z'),
  });

/**
 * Glow Salon (A, Salon): six customer coupons + three complimentary. Calm Spa (B, Spa): two.
 * Totals — customer: 8 (1 void → 7 issued), 3 redeemed, 2 expired, 2 active.
 */
const seedFixture = async () => {
  const salon = await makeCategory({ key: 'salon', name: 'Salon', sortOrder: 1, enabled: true });
  const spa = await makeCategory({ key: 'spa', name: 'Spa', sortOrder: 2, enabled: true });
  const a = await makeCompleteSeller({ status: 'active', categoryId: salon._id, phone: '9600000001' });
  const b = await makeCompleteSeller({ status: 'active', categoryId: spa._id, phone: '9600000002' });
  await Seller.updateOne({ _id: b.seller._id }, { $set: { businessName: 'Calm Spa' } });
  await SellerUser.updateOne({ _id: b.owner._id }, { $set: { name: 'Bina Owner' } });
  const manager = await SellerUser.create({ sellerId: a.seller._id, name: 'Meera Nair', phone: '9700000001', role: 'manager' });
  const employee = await SellerUser.create({ sellerId: a.seller._id, name: 'Ravi Kumar', phone: '9700000002', role: 'employee' });
  const subA = await subscription(a.seller._id, { key: 'basic', allocated: 250, issued: 5 });
  const subB = await subscription(b.seller._id, { key: 'plus', allocated: 900, issued: 2 });
  const offerA = await CouponOffer.create({ sellerId: a.seller._id, categoryId: salon._id, title: '20% off any haircut', status: 'approved' });
  const offerB = await CouponOffer.create({ sellerId: b.seller._id, categoryId: spa._id, title: 'Free foot massage', status: 'approved' });

  const customers = await User.create([
    { name: 'Priya Sharma', phone: '9811100001', role: 'customer', gender: 'female', dateOfBirth: new Date('1994-03-02') },
    { name: 'Rahul Verma', phone: '9811100002', role: 'customer' },
    { name: 'Anita', phone: '9811100003', role: 'customer' },
    { name: 'Formula', phone: '9811100004', role: 'customer' },
    { name: 'Kiran Rao', phone: '9811100005', role: 'customer' },
    { name: 'Vikram Singh', phone: '9811100006', role: 'customer' },
  ]);
  const snap = (name, gender, dob) => ({ name, gender, dateOfBirth: dob ? new Date(dob) : null });
  const make = (seller, sub, offer, category, customer, over) =>
    Coupon.create({
      code: generateCouponCode(),
      kind: 'customer',
      sellerId: seller._id,
      subscriptionId: sub._id,
      offerId: offer._id,
      offerSnapshot: { title: offer.title, terms: '' },
      categoryId: category._id,
      customerId: customer._id,
      source: { type: 'order', id: new mongoose.Types.ObjectId() },
      ...over,
    });
  const A = (customer, over) => make(a.seller, subA, offerA, salon, customer, over);
  const B = (customer, over) => make(b.seller, subB, offerB, spa, customer, over);

  const c = {};
  c.a1 = await A(customers[0], { customerSnapshot: snap('Priya Sharma', 'female', '1994-03-02'), issuedAt: new Date('2026-03-01T18:40:00Z'), expiresAt: FAR });
  c.a2 = await A(customers[1], {
    customerSnapshot: snap('Rahul Verma', 'male', '2000-01-10'),
    issuedAt: new Date('2026-03-01T18:20:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-03-03T05:00:00Z'),
    redeemedBy: employee._id,
  });
  c.a3 = await A(customers[2], { customerSnapshot: snap('Anita', 'female', '2009-05-05'), issuedAt: new Date('2026-03-10T06:00:00Z'), expiresAt: new Date('2026-04-09T06:00:00Z') });
  c.a4 = await A(customers[3], {
    customerSnapshot: snap('=HYPERLINK("http://x")', null, null),
    issuedAt: new Date('2026-04-05T06:00:00Z'),
    expiresAt: new Date('2026-05-05T06:00:00Z'),
    status: 'expired',
  });
  c.a5 = await A(customers[4], { customerSnapshot: snap('Kiran Rao', 'other', '1960-01-01'), issuedAt: new Date('2026-04-20T06:00:00Z'), expiresAt: FAR, status: 'void' });
  c.a6 = await A(customers[5], {
    customerSnapshot: snap('Vikram Singh', 'male', '1985-06-15'),
    issuedAt: new Date('2026-04-21T06:00:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-04-22T10:00:00Z'),
    redeemedBy: a.owner._id,
  });
  c.b1 = await B(customers[0], { customerSnapshot: snap('Priya Sharma', 'female', '1994-03-02'), issuedAt: new Date('2026-03-05T06:00:00Z'), expiresAt: FAR });
  c.b2 = await B(customers[1], {
    customerSnapshot: snap('Rahul Verma', 'male', '2000-01-10'),
    issuedAt: new Date('2026-04-25T06:00:00Z'),
    expiresAt: FAR,
    status: 'redeemed',
    redeemedAt: new Date('2026-04-26T06:00:00Z'),
    redeemedBy: b.owner._id,
  });
  const comp = (n, over = {}) =>
    Coupon.create({
      code: generateCouponCode(),
      kind: 'complimentary',
      sellerId: a.seller._id,
      subscriptionId: subA._id,
      categoryId: salon._id,
      source: { type: 'plan', id: subA._id },
      issueKey: `plan:${subA._id}:${n}`,
      issuedAt: new Date('2026-02-20T00:00:00Z'),
      expiresAt: FAR,
      ...over,
    });
  c.c1 = await comp(1, { assignedTo: { name: 'Team Member', phone: '9900000001', note: 'Launch event', at: new Date('2026-02-21T00:00:00Z') } });
  c.c2 = await comp(2);
  c.c3 = await comp(3, { status: 'redeemed', redeemedAt: new Date('2026-02-25T00:00:00Z') });

  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  return {
    salon,
    spa,
    a,
    b,
    manager,
    employee,
    subA,
    subB,
    offerA,
    customers,
    c,
    admin,
    adminHeaders: { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` },
  };
};

const admin = (method, path, body, headers = fx.adminHeaders) => srv.request(method, `/api/admin${path}`, { body, headers });
const list = async (q = '') => {
  const res = await admin('GET', `/coupons${q}`);
  assert.equal(res.status, 200, `${q}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};
const ids = (rows) => rows.map((r) => r.id).sort();
const idsOf = (...keys) => keys.map((k) => String(fx.c[k]._id)).sort();

// ── List and filters ──────────────────────────────────────────────────────────

test('the list: every coupon (complimentary too), newest first, with the customer mobile and age at issue', async () => {
  const all = await list();
  assert.equal(all.total, 11);
  assert.equal(all.coupons[0].id, String(fx.c.b2._id), 'newest first');
  const rahul = all.coupons.find((r) => r.id === String(fx.c.a2._id));
  assert.equal(rahul.customerName, 'Rahul Verma');
  assert.equal(rahul.mobile, '9811100002');
  assert.equal(rahul.age, 26);
  assert.equal(rahul.gender, 'male');
  assert.deepEqual(rahul.category, { id: String(fx.salon._id), name: 'Salon' });
  assert.deepEqual(rahul.seller, { id: String(fx.a.seller._id), name: 'Glow Salon' });
  assert.equal(rahul.status, 'redeemed');
  assert.equal(rahul.redeemedBy.name, 'Ravi Kumar');
  assert.equal(rahul.code, fx.c.a2.code);
  const c1 = all.coupons.find((r) => r.id === String(fx.c.c1._id));
  assert.equal(c1.kind, 'complimentary');
  assert.equal(c1.customerName, 'Team Member');
  assert.equal(c1.mobile, '9900000001');
  assert.equal(all.coupons.find((r) => r.id === String(fx.c.a3._id)).status, 'expired', 'past its date');

  const p2 = await list('?limit=4&page=3');
  assert.equal(p2.coupons.length, 3);
  const oldest = await list('?sort=issuedAt&limit=1');
  assert.equal(oldest.coupons[0].kind, 'complimentary');
  const soonest = await list('?sort=expiresAt&limit=1');
  assert.equal(soonest.coupons[0].id, String(fx.c.a3._id));
});

test('every filter', async () => {
  const cases = [
    ['?kind=complimentary', ['c1', 'c2', 'c3']],
    ['?kind=customer', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1', 'b2']],
    [`?category=${fx.spa._id}`, ['b1', 'b2']],
    [`?seller=${fx.a.seller._id}`, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'c1', 'c2', 'c3']],
    ['?status=redeemed', ['a2', 'a6', 'b2', 'c3']],
    ['?status=expired', ['a3', 'a4']],
    ['?status=issued', ['a1', 'b1', 'c1', 'c2']],
    ['?status=void', ['a5']],
    // IST dates: a1 (00:10 IST on 2 Mar) is in, a2 (23:50 IST on 1 Mar) is out.
    ['?issuedFrom=2026-03-02&issuedTo=2026-03-31', ['a1', 'a3', 'b1']],
    ['?issuedTo=2026-03-01', ['a2', 'c1', 'c2', 'c3']],
    ['?expiringFrom=2026-04-01&expiringTo=2026-05-31', ['a3', 'a4']],
    ['?kind=customer&gender=female', ['a1', 'a3', 'b1']],
    ['?kind=customer&gender=not_given', ['a4']],
    ['?ageBand=25-34', ['a1', 'a2', 'b1', 'b2']],
    ['?ageBand=under-18', ['a3']],
    ['?ageBand=35-44', ['a6']],
    ['?ageBand=55%2B', ['a5']],
    ['?kind=customer&ageBand=not-given', ['a4']],
    ['?search=rahul', ['a2', 'b2']],
    ['?search=9811100002', ['a2', 'b2']],
    ['?search=%2B91%2098111%2000002', ['a2', 'b2']],
    ['?search=100002', ['a2', 'b2']],
    [`?search=${fx.c.a6.code.toLowerCase().slice(0, 5)}-${fx.c.a6.code.slice(5)}`, ['a6']],
    ['?search=team%20member', ['c1']],
    ['?search=9900000001', ['c1']],
    [`?seller=${fx.a.seller._id}&status=redeemed&kind=customer`, ['a2', 'a6']],
    ['?status=expired&search=anita', ['a3']],
  ];
  for (const [q, expected] of cases) {
    const data = await list(`${q}${q.includes('?') ? '&' : '?'}limit=200`);
    assert.deepEqual(ids(data.coupons), idsOf(...expected), q);
    assert.equal(data.total, expected.length, `${q} total`);
  }
  for (const q of ['?status=used', '?kind=gift', '?category=nope', '?issuedFrom=2026-02-30', '?ageBand=30-40', '?sort=name', '?limit=500', '?unknown=1']) {
    assert.equal((await admin('GET', `/coupons${q}`)).status, 400, q);
  }
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test('CSV export: same filters, header, formula-safe cells, mobile numbers, an audit row with the filters', async () => {
  const res = await srv.get('/api/admin/coupons/export.csv?kind=customer&sort=issuedAt', fx.adminHeaders);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="coupons-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Code,Kind,Customer,Mobile,Age,Gender,Category,Seller,Seller ID,Offer,Issued (IST),Expires (IST),Status,Redeemed (IST),Redeemed by');
  assert.equal(lines.length, 9, 'header + 8 customer coupons');
  assert.equal(lines[1], `${fx.c.a2.code},customer,Rahul Verma,9811100002,26,Male,Salon,Glow Salon,${fx.a.seller._id},20% off any haircut,2026-03-01 23:50,2099-01-01 05:30,redeemed,2026-03-03 10:30,Ravi Kumar`);
  // A customer who gave no gender / date of birth reads "Not given", not a blank (CF10 browser run).
  assert.ok(lines.slice(1).some((l) => l.includes(',Not given,Not given,')), lines.join('\n'));
  const formula = lines.find((l) => l.includes('HYPERLINK'));
  assert.ok(formula.includes(`,"'=HYPERLINK(""http://x"")",`), `stays text: ${formula}`);

  const log = await AdminActivityLog.findOne({ action: 'COUPONS_EXPORTED' }).lean();
  assert.ok(log, 'audit row');
  assert.equal(String(log.adminId), String(fx.admin._id));
  assert.equal(log.targetType, 'coupon');
  assert.equal(log.metadata.filters.kind, 'customer');
  assert.equal(log.metadata.filters.sort, 'issuedAt');

  const filtered = await srv.get(`/api/admin/coupons/export.csv?seller=${fx.b.seller._id}`, fx.adminHeaders);
  assert.equal(filtered.body.trim().split('\r\n').length, 3);
  assert.equal((await srv.get('/api/admin/coupons/export.csv?status=nope', fx.adminHeaders)).status, 400);
});

test(`CSV export is rate-limited (${ADMIN_EXPORT_LIMIT} a minute per admin)`, async () => {
  // A fresh admin, so the earlier test's downloads don't count.
  const other = await User.create({ name: 'Root Two', email: 'admin2@test.local', role: 'admin' });
  const headers = { authorization: `Bearer ${generateTokens(other._id, 'admin').accessToken}` };
  for (let i = 0; i < ADMIN_EXPORT_LIMIT; i += 1) {
    assert.equal((await srv.get('/api/admin/coupons/export.csv?kind=complimentary', headers)).status, 200, `export ${i + 1}`);
  }
  const limited = await srv.get('/api/admin/coupons/export.csv', headers);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal((await srv.get('/api/admin/coupons', headers)).status, 200, 'the list is not limited');
});

// ── Complimentary ─────────────────────────────────────────────────────────────

test('complimentary: listed by seller and plan; assign (and re-assign) to a team member; mark used once', async () => {
  const listed = (await admin('GET', `/coupons/complimentary?seller=${fx.a.seller._id}`)).body.data;
  assert.equal(listed.total, 3);
  assert.equal(listed.groups.length, 1);
  assert.equal(listed.groups[0].plan.name, 'Basic');
  assert.equal(listed.groups[0].seller.name, 'Glow Salon');
  assert.equal((await admin('GET', '/coupons/complimentary?assigned=false')).body.data.total, 2);
  assert.equal((await admin('GET', '/coupons/complimentary?status=redeemed')).body.data.total, 1);

  const assigned = await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/assign`, { name: 'Sana Khan', phone: '+91 99000 00002', note: 'For the review visit' });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.data.coupon.assignedTo.phone, '9900000002');
  const again = await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/assign`, { name: 'Imran Ali', phone: '9900000003' });
  assert.equal(again.body.data.coupon.assignedTo.name, 'Imran Ali');
  const logs = await AdminActivityLog.find({ action: 'COUPON_COMPLIMENTARY_ASSIGNED', targetId: fx.c.c2._id }).sort({ createdAt: 1 }).lean();
  assert.equal(logs.length, 2);
  assert.equal(logs[1].metadata.previous, 'Sana Khan');

  for (const body of [{ name: 'X', phone: '9900000003' }, { name: 'Valid', phone: '123' }, { name: 'Valid', phone: '9900000003', extra: 1 }]) {
    assert.equal((await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/assign`, body)).status, 400, JSON.stringify(body));
  }

  const used = await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/mark-used`);
  assert.equal(used.status, 200);
  assert.equal(used.body.data.coupon.status, 'redeemed');
  const twice = await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/mark-used`);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'COUPON_ALREADY_REDEEMED');
  assert.equal((await admin('PATCH', `/coupons/complimentary/${fx.c.c2._id}/assign`, { name: 'Late Person', phone: '9900000004' })).status, 409, 'used coupons stay with whoever had them');
  assert.ok(await AdminActivityLog.exists({ action: 'COUPON_COMPLIMENTARY_USED', targetId: fx.c.c2._id }));

  await Coupon.updateOne({ _id: fx.c.c1._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await admin('PATCH', `/coupons/complimentary/${fx.c.c1._id}/mark-used`)).status, 410);
  // A customer coupon is not a complimentary one.
  assert.equal((await admin('PATCH', `/coupons/complimentary/${fx.c.a1._id}/assign`, { name: 'Someone', phone: '9900000005' })).status, 404);
  assert.equal((await admin('PATCH', `/coupons/complimentary/${fx.c.a1._id}/mark-used`)).status, 404);
  assert.equal((await Coupon.findById(fx.c.a1._id).lean()).status, 'issued');
});

// ── Manual issue ──────────────────────────────────────────────────────────────

test('manual issue: from the chosen seller\'s stock, audit-logged, a retried request issues once', async () => {
  const res = await admin('POST', '/coupons/issue', { phone: '98111 00001', sellerId: String(fx.a.seller._id), note: 'Complaint goodwill', requestId: 'req-0001-abcd' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const coupon = res.body.data.coupon;
  assert.equal(coupon.customerName, 'Priya Sharma');
  assert.equal(coupon.mobile, '9811100001');
  assert.equal(coupon.source, 'manual');
  assert.equal(coupon.seller.name, 'Glow Salon');
  assert.equal(coupon.offerTitle, '20% off any haircut');
  const stored = await Coupon.findById(coupon.id).lean();
  assert.equal(stored.customerSnapshot.gender, 'female', 'snapshot from the profile');
  assert.equal(Math.round((stored.expiresAt - stored.issuedAt) / 86_400_000), 30);
  const sub = await SellerSubscription.findById(fx.subA._id).lean();
  assert.equal(sub.remaining, 244);
  assert.equal(sub.issued, 6);
  const log = await AdminActivityLog.findOne({ action: 'COUPON_ISSUED_MANUALLY' }).lean();
  assert.equal(String(log.targetId), coupon.id);
  assert.equal(log.metadata.note, 'Complaint goodwill');

  const retried = await admin('POST', '/coupons/issue', { phone: '9811100001', sellerId: String(fx.a.seller._id), requestId: 'req-0001-abcd' });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.data.duplicate, true);
  assert.equal(retried.body.data.coupon.id, coupon.id);
  assert.equal((await SellerSubscription.findById(fx.subA._id).lean()).remaining, 244, 'stock taken once');
  // The customer sees it.
  const mine = await srv.get('/api/users/me/coupons', { authorization: `Bearer ${generateTokens(fx.customers[0]._id, 'customer').accessToken}` });
  assert.ok(mine.body.data.coupons.some((c) => c.id === coupon.id));
});

test('manual issue refusals: unknown customer, inactive seller, no approved offer, no stock — stock untouched', async () => {
  const issue = (body) => admin('POST', '/coupons/issue', { sellerId: String(fx.a.seller._id), phone: '9811100001', ...body });
  assert.equal((await issue({ phone: '9811199999' })).body.code, 'CUSTOMER_NOT_FOUND');
  assert.equal((await issue({ phone: '12' })).status, 400);
  assert.equal((await issue({ offerId: String(new mongoose.Types.ObjectId()) })).body.code, 'NO_APPROVED_OFFER');

  await SellerSubscription.updateOne({ _id: fx.subA._id }, { $set: { remaining: 0, issued: 250, status: 'exhausted' } });
  const empty = await issue({});
  assert.equal(empty.status, 409);
  assert.equal(empty.body.code, 'NO_STOCK');

  await Seller.updateOne({ _id: fx.b.seller._id }, { $set: { status: 'suspended' } });
  assert.equal((await issue({ sellerId: String(fx.b.seller._id) })).body.code, 'SELLER_NOT_ACTIVE');
  assert.equal((await SellerSubscription.findById(fx.subB._id).lean()).remaining, 898);
  assert.equal(await Coupon.countDocuments({ 'source.type': 'manual' }), 0);
});

// ── Reports ───────────────────────────────────────────────────────────────────

const report = async (path) => {
  const res = await admin('GET', `/coupon-reports${path}`);
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

test('summary and by-category / by-seller match the fixture', async () => {
  const s = await report('/summary');
  assert.deepEqual(
    { issued: s.issued, pending: s.pending, active: s.active, redeemed: s.redeemed, expired: s.expired, void: s.void, redemptionRate: s.redemptionRate },
    { issued: 7, pending: 1143, active: 2, redeemed: 3, expired: 2, void: 1, redemptionRate: 42.86 }
  );
  assert.deepEqual(s.stock, { allocated: 1150, issued: 7, pending: 1143 });
  assert.deepEqual(s.complimentary, { total: 3, assigned: 1, used: 1, expired: 0, unused: 2 });

  const salonOnly = await report(`/summary?category=${fx.salon._id}`);
  assert.equal(salonOnly.issued, 5);
  assert.equal(salonOnly.pending, 245);
  const march = await report('/summary?from=2026-03-01&to=2026-03-31');
  assert.equal(march.issued, 4);

  const cats = (await report('/by-category')).categories;
  assert.deepEqual(cats.map((c) => [c.name, c.issued, c.active, c.redeemed, c.expired, c.void, c.redemptionRate]), [
    ['Salon', 5, 1, 2, 2, 1, 40],
    ['Spa', 2, 1, 1, 0, 0, 50],
  ]);

  const sellers = (await report('/by-seller')).sellers;
  assert.deepEqual(sellers.map((x) => [x.name, x.issued, x.redeemed]), [['Glow Salon', 5, 2], ['Calm Spa', 2, 1]]);
  assert.deepEqual((await report('/by-seller?from=2026-04-22')).sellers.map((x) => [x.name, x.issued]), [['Calm Spa', 1]]);
});

test('demographics and trends match the fixture', async () => {
  const d = await report('/demographics');
  assert.equal(d.total, 8);
  assert.deepEqual(d.gender, { male: 3, female: 3, other: 1, not_given: 1 });
  assert.deepEqual(d.ageBands, { 'under-18': 1, '18-24': 0, '25-34': 4, '35-44': 1, '45-54': 0, '55+': 1, 'not-given': 1 });
  assert.deepEqual((await report(`/demographics?seller=${fx.b.seller._id}`)).gender, { male: 1, female: 1, other: 0, not_given: 0 });

  const month = await report('/trends?interval=month&from=2026-03-01&to=2026-04-30');
  assert.deepEqual(month.series, [
    { bucket: '2026-03', issued: 4, redeemed: 1 },
    { bucket: '2026-04', issued: 4, redeemed: 2 },
  ]);
  const day = await report(`/trends?interval=day&from=2026-03-01&to=2026-03-03&category=${fx.salon._id}`);
  assert.deepEqual(day.series.map((x) => [x.bucket, x.issued, x.redeemed]), [
    ['2026-03-01', 1, 0],
    ['2026-03-02', 1, 0],
    ['2026-03-03', 0, 1],
  ]);
  assert.equal((await admin('GET', '/coupon-reports/trends?interval=year')).status, 400);
});

test('employees: every seller login with role, phone, redemptions and the last one; sellers: business, plan and numbers', async () => {
  const e = (await report('/employees')).employees;
  const row = (name) => e.find((x) => x.name === name);
  assert.deepEqual(
    { role: row('Ravi Kumar').role, phone: row('Ravi Kumar').phone, n: row('Ravi Kumar').redemptions, last: row('Ravi Kumar').lastRedemptionAt },
    { role: 'employee', phone: '9700000002', n: 1, last: '2026-03-03T05:00:00.000Z' }
  );
  assert.equal(row('Asha Rao').redemptions, 1);
  assert.equal(row('Meera Nair').redemptions, 0);
  assert.equal(row('Meera Nair').lastRedemptionAt, null);
  assert.equal(row('Bina Owner').redemptions, 1);
  assert.equal(row('Bina Owner').seller.name, 'Calm Spa');
  const onlyA = (await report(`/employees?seller=${fx.a.seller._id}`)).employees;
  assert.deepEqual(onlyA.map((x) => x.name).sort(), ['Asha Rao', 'Meera Nair', 'Ravi Kumar']);
  assert.equal((await report('/employees?from=2026-04-01')).employees.find((x) => x.name === 'Ravi Kumar').redemptions, 0, 'by redemption date');

  const s = (await report('/sellers')).sellers;
  const glow = s.find((x) => x.businessName === 'Glow Salon');
  assert.deepEqual(
    { category: glow.category, status: glow.status, city: glow.city, plan: glow.currentPlan.name, allocated: glow.allocated, issued: glow.issued, pending: glow.pending, redeemed: glow.redeemed, expired: glow.expired },
    { category: 'Salon', status: 'active', city: 'Bengaluru', plan: 'Basic', allocated: 250, issued: 5, pending: 245, redeemed: 2, expired: 2 }
  );
  assert.equal(s.find((x) => x.businessName === 'Calm Spa').pending, 898);
  assert.equal((await admin('GET', '/coupon-reports/summary?from=2026-05-01&to=2026-04-01')).status, 400);
});

// ── Settings ──────────────────────────────────────────────────────────────────

test('coupon settings: read, save a new version (audit-logged), history kept, bad or unchanged input refused', async () => {
  const first = (await admin('GET', '/coupon-settings')).body.data;
  assert.equal(first.active.version, 1);
  assert.equal(first.active.perOrderCap, 3);
  assert.equal(first.versions.length, 1);
  assert.ok(first.units.perOrderCap);

  const saved = await admin('PUT', '/coupon-settings', { perOrderCap: 2, radiusKm: 5, note: 'Pilot city' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.version.version, 2);
  assert.deepEqual(saved.body.data.changes.map((c) => [c.field, c.from, c.to]), [['perOrderCap', 3, 2], ['radiusKm', 10, 5]]);
  const log = await AdminActivityLog.findOne({ action: 'COUPON_SETTINGS_UPDATED' }).lean();
  assert.equal(log.targetType, 'coupon_settings');
  assert.equal(log.metadata.version, 2);

  const after = (await admin('GET', '/coupon-settings')).body.data;
  assert.equal(after.active.perOrderCap, 2);
  assert.equal(after.active.defaultValidityDays, 30, 'unchanged fields carry over');
  assert.deepEqual(after.versions.map((v) => v.version), [2, 1]);

  assert.equal((await admin('PUT', '/coupon-settings', { perOrderCap: 2 })).body.code, 'NO_CHANGES');
  for (const body of [{ perOrderCap: 0 }, { radiusKm: -1 }, { bogus: 1 }, { perOrderCap: '3' }]) {
    assert.equal((await admin('PUT', '/coupon-settings', body)).status, 400, JSON.stringify(body));
  }
  // Coupon validity is fixed at 30 days (Nov 2026): the admin can't change it either.
  const validity = await admin('PUT', '/coupon-settings', { defaultValidityDays: 45 });
  assert.equal(validity.status, 400);
  assert.match(validity.body.message, /fixed at 30 days/);
  assert.equal(await CouponSettings.countDocuments(), 2);
});

// ── Access ────────────────────────────────────────────────────────────────────

test('admin only: a customer gets 403 and no token 401 on every route', async () => {
  const customer = { authorization: `Bearer ${generateTokens(fx.customers[0]._id, 'customer').accessToken}` };
  const id = String(fx.c.c2._id);
  const routes = [
    ['GET', '/coupons'],
    ['GET', '/coupons/export.csv'],
    ['GET', '/coupons/complimentary'],
    ['PATCH', `/coupons/complimentary/${id}/assign`, { name: 'Sneaky', phone: '9900000009' }],
    ['PATCH', `/coupons/complimentary/${id}/mark-used`],
    ['POST', '/coupons/issue', { phone: '9811100001', sellerId: String(fx.a.seller._id) }],
    ['GET', '/coupon-reports/summary'],
    ['GET', '/coupon-reports/by-category'],
    ['GET', '/coupon-reports/by-seller'],
    ['GET', '/coupon-reports/demographics'],
    ['GET', '/coupon-reports/trends'],
    ['GET', '/coupon-reports/employees'],
    ['GET', '/coupon-reports/sellers'],
    ['GET', '/coupon-settings'],
    ['PUT', '/coupon-settings', { perOrderCap: 1 }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await admin(method, path, body, customer)).status, 403, `customer ${method} ${path}`);
    assert.equal((await admin(method, path, body, {})).status, 401, `anonymous ${method} ${path}`);
  }
  assert.equal((await Coupon.findById(id).lean()).status, 'issued');
  assert.equal(await CouponSettings.countDocuments(), 0, 'nothing written (not even the seed)');
});
