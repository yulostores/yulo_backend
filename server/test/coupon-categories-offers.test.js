// CB5 — coupon categories (the super admin's on/off switches, with sellers and stock per
// category) and seller offers (the full state machine, review queue, edit-after-approval going
// back to review, one seller never seeing another's). In-memory MongoDB, in-memory Redis stand-in.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller, sellerHeaders } = await import('../test-utils/sellerFixtures.mjs');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let admin;
let adminHeaders;
let salon;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CouponCategory.init(), CouponOffer.init()]);
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
  admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  salon = await makeCategory({ key: 'salon', name: 'Salon', sortOrder: 2 });
});

const admin$ = (method, path, body, headers = adminHeaders) => srv.request(method, `/api/admin${path}`, { body, headers });
const seller$ = (method, path, body, headers) => srv.request(method, `/api/seller/offers${path}`, { body, headers });
let phoneN = 10;
const activeSeller = (over = {}) => makeCompleteSeller({ status: 'active', categoryId: salon._id, phone: `90000000${(phoneN += 1)}`, ...over });

const offerBody = (over = {}) => ({ title: '20% off any haircut', terms: 'Weekdays only. One per visit.', validityDays: 30, ...over });
const createOffer = async (headers, over) => {
  const res = await seller$('POST', '', offerBody(over), headers);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.offer;
};

// ── Categories ────────────────────────────────────────────────────────────────

test('categories list in sort order with active sellers, live offers and stock per category', async () => {
  const spa = await makeCategory({ key: 'spa', name: 'Spa', sortOrder: 1 });
  const a = await activeSeller();
  const b = await activeSeller();
  await activeSeller({ status: 'pending' }); // not counted
  await SellerSubscription.create({
    sellerId: a.seller._id,
    planSnapshot: { planId: new mongoose.Types.ObjectId(), key: 'basic', name: 'Basic', basePricePaise: 1, gstPercent: 18, gstPaise: 0, totalPaise: 1, couponAllocation: 250, complimentaryCount: 5 },
    payment: { method: 'manual' },
    status: 'active',
    allocated: 250,
    remaining: 240,
  });
  await CouponOffer.create({ sellerId: b.seller._id, categoryId: salon._id, title: 'Free wash', status: 'approved' });

  const res = await admin$('GET', '/coupon-categories');
  assert.equal(res.status, 200);
  const [first, second] = res.body.data.categories;
  assert.equal(first.key, 'spa');
  assert.equal(String(first._id), String(spa._id));
  assert.deepEqual([first.activeSellers, first.stockRemaining], [0, 0]);
  assert.equal(second.key, 'salon');
  assert.deepEqual([second.activeSellers, second.sellersWithLiveOffer, second.stockRemaining], [2, 1, 240]);
});

test('toggling a category on and off is saved and audit-logged each way', async () => {
  const on = await admin$('PATCH', `/coupon-categories/${salon._id}`, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.data.category.enabled, true);
  assert.match(on.body.message, /will now receive/);
  assert.equal((await CouponCategory.findById(salon._id).lean()).enabled, true);

  const off = await admin$('PATCH', `/coupon-categories/${salon._id}`, { enabled: false });
  assert.equal(off.body.data.category.enabled, false);
  const actions = (await AdminActivityLog.find({ targetType: 'coupon_category' }).sort({ createdAt: 1 }).lean()).map((l) => l.action);
  assert.deepEqual(actions, ['COUPON_CATEGORY_ENABLED', 'COUPON_CATEGORY_DISABLED']);
});

test('renaming and re-ordering a category; creating one; validation and duplicates', async () => {
  const res = await admin$('PATCH', `/coupon-categories/${salon._id}`, { name: 'Salon & Barber', sortOrder: -5, icon: 'scissors' });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.data.category.name, res.body.data.category.sortOrder, res.body.data.category.icon], ['Salon & Barber', -5, 'scissors']);
  const [log] = await AdminActivityLog.find({ action: 'COUPON_CATEGORY_UPDATED' }).lean();
  assert.deepEqual(log.metadata.changes.map((c) => c.field).sort(), ['icon', 'name', 'sortOrder']);

  const created = await admin$('POST', '/coupon-categories', { key: 'Gym', name: 'Gym', sortOrder: 9 });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.category.key, 'gym');
  assert.equal(created.body.data.category.enabled, false, 'new categories start off');
  assert.equal((await admin$('POST', '/coupon-categories', { key: 'gym', name: 'Gym 2' })).status, 409);

  for (const bad of [{}, { enabled: 'yes' }, { key: 'salon2' }, { sortOrder: 1.5 }, { name: 'x' }]) {
    assert.equal((await admin$('PATCH', `/coupon-categories/${salon._id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await admin$('POST', '/coupon-categories', { key: 'bad key!', name: 'Bad' })).status, 400);
  assert.equal((await admin$('PATCH', `/coupon-categories/${new mongoose.Types.ObjectId()}`, { enabled: true })).status, 404);
  assert.equal((await admin$('PATCH', '/coupon-categories/nope', { enabled: true })).status, 400);
});

test('categories and the offer review queue are admin-only', async () => {
  const { headers } = await activeSeller();
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  const asCustomer = { authorization: `Bearer ${auth.generateTokens(customer._id, 'customer').accessToken}` };
  for (const [method, path, body] of [
    ['GET', '/coupon-categories'],
    ['POST', '/coupon-categories', { key: 'gym', name: 'Gym' }],
    ['PATCH', `/coupon-categories/${salon._id}`, { enabled: true }],
    ['GET', '/coupon-offers'],
    ['PATCH', `/coupon-offers/${new mongoose.Types.ObjectId()}/approve`],
  ]) {
    assert.equal((await admin$(method, path, body, asCustomer)).status, 403, `customer ${method} ${path}`);
    assert.equal((await admin$(method, path, body, headers)).status, 401, `seller ${method} ${path}`);
    assert.equal((await admin$(method, path, body, {})).status, 401, `no token ${method} ${path}`);
  }
  assert.equal((await CouponCategory.findById(salon._id).lean()).enabled, false);
});

// ── Offers: the seller side ───────────────────────────────────────────────────

test('a new offer is a draft in the seller\'s own category, whatever the body says', async () => {
  const { headers } = await activeSeller();
  const offer = await createOffer(headers);
  assert.equal(offer.status, 'draft');
  assert.equal(String(offer.categoryId), String(salon._id));
  assert.equal(offer.validityDays, 30);
  const withCategory = await seller$('POST', '', offerBody({ categoryId: String(new mongoose.Types.ObjectId()) }), headers);
  assert.equal(withCategory.status, 400, 'the category cannot be chosen');

  for (const bad of [{ title: 'ab' }, { validityDays: 0 }, { validityDays: 366 }, { validityDays: 2.5 }, { terms: 'x'.repeat(2001) }]) {
    assert.equal((await seller$('POST', '', offerBody(bad), headers)).status, 400, JSON.stringify(bad));
  }
  const list = await seller$('GET', '', undefined, headers);
  assert.equal(list.body.data.offers.length, 1);
});

test('the full journey: draft → review → approved → paused → running again', async () => {
  const { headers } = await activeSeller();
  const offer = await createOffer(headers);

  const submitted = await seller$('POST', `/${offer._id}/submit`, undefined, headers);
  assert.equal(submitted.body.data.offer.status, 'pending_review');

  const queue = await admin$('GET', '/coupon-offers?status=pending_review');
  assert.equal(queue.body.data.total, 1);
  assert.equal(queue.body.data.offers[0].seller.businessName, 'Glow Salon');
  assert.equal(queue.body.data.offers[0].category.name, 'Salon');
  assert.equal(queue.body.data.statusCounts.pending_review, 1);

  const approved = await admin$('PATCH', `/coupon-offers/${offer._id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.offer.status, 'approved');
  assert.equal((await AdminActivityLog.countDocuments({ action: 'COUPON_OFFER_APPROVED', targetId: offer._id })), 1);

  assert.equal((await seller$('POST', `/${offer._id}/pause`, undefined, headers)).body.data.offer.status, 'paused');
  const resumed = await seller$('POST', `/${offer._id}/resume`, undefined, headers);
  assert.equal(resumed.body.data.offer.status, 'approved', 'an unchanged offer resumes without review');
});

test('a rejected offer shows the reason, is edited back to a draft, and can be submitted again', async () => {
  const { headers } = await activeSeller();
  const offer = await createOffer(headers);
  await seller$('POST', `/${offer._id}/submit`, undefined, headers);

  assert.equal((await admin$('PATCH', `/coupon-offers/${offer._id}/reject`, {})).status, 400, 'a reason is required');
  const rejected = await admin$('PATCH', `/coupon-offers/${offer._id}/reject`, { reason: 'Say which services are included' });
  assert.equal(rejected.body.data.offer.status, 'rejected');
  const mine = (await seller$('GET', '', undefined, headers)).body.data.offers[0];
  assert.equal(mine.rejectionReason, 'Say which services are included');

  const edited = await seller$('PATCH', `/${offer._id}`, { terms: 'Haircut and wash included.' }, headers);
  assert.equal(edited.body.data.offer.status, 'draft');
  assert.equal(edited.body.data.offer.rejectionReason, null);
  assert.equal((await seller$('POST', `/${offer._id}/submit`, undefined, headers)).body.data.offer.status, 'pending_review');
});

test('editing an approved or paused offer sends it back to review', async () => {
  const { headers } = await activeSeller();
  for (const pauseFirst of [false, true]) {
    const offer = await createOffer(headers, { title: pauseFirst ? 'Paused one' : 'Live one' });
    await seller$('POST', `/${offer._id}/submit`, undefined, headers);
    await admin$('PATCH', `/coupon-offers/${offer._id}/approve`);
    if (pauseFirst) await seller$('POST', `/${offer._id}/pause`, undefined, headers);

    const res = await seller$('PATCH', `/${offer._id}`, { title: '25% off any haircut' }, headers);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.offer.status, 'pending_review', pauseFirst ? 'paused' : 'approved');
    assert.match(res.body.message, /sent for review/);
    const stored = await CouponOffer.findById(offer._id).lean();
    assert.equal(stored.title, '25% off any haircut');
    assert.equal(stored.reviewedAt, null);
  }
});

test('the state machine refuses every move that is not allowed', async () => {
  const { headers } = await activeSeller();
  const at = async (status) => (await CouponOffer.create({ sellerId: (await SellerUser.findOne({}).lean()).sellerId, categoryId: salon._id, title: `Offer ${status}`, status }))._id;
  const sellerMoves = { submit: ['pending_review', 'approved', 'paused'], pause: ['draft', 'pending_review', 'rejected', 'paused'], resume: ['draft', 'pending_review', 'approved', 'rejected'] };
  for (const [action, statuses] of Object.entries(sellerMoves)) {
    for (const status of statuses) {
      const id = await at(status);
      const res = await seller$('POST', `/${id}/${action}`, undefined, headers);
      assert.equal(res.status, 409, `${action} from ${status}`);
      assert.equal(res.body.code, 'INVALID_STATE');
      assert.equal((await CouponOffer.findById(id).lean()).status, status);
    }
  }
  for (const status of ['draft', 'approved', 'paused', 'rejected']) {
    const id = await at(status);
    assert.equal((await admin$('PATCH', `/coupon-offers/${id}/approve`)).status, 409, `approve from ${status}`);
    assert.equal((await admin$('PATCH', `/coupon-offers/${id}/reject`, { reason: 'Not now please' })).status, 409, `reject from ${status}`);
  }
  assert.equal((await admin$('PATCH', `/coupon-offers/${new mongoose.Types.ObjectId()}/approve`)).status, 404);
});

test('an admin never approves text they did not see: a decision on a changed offer is refused', async () => {
  const { headers } = await activeSeller();
  const offer = await createOffer(headers);
  await seller$('POST', `/${offer._id}/submit`, undefined, headers);
  const seen = (await admin$('GET', '/coupon-offers?status=pending_review')).body.data.offers[0].updatedAt;

  // The seller edits after the admin opened it.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await seller$('PATCH', `/${offer._id}`, { title: 'Changed at the last second' }, headers)).status, 200);

  for (const [path, body] of [['approve', { updatedAt: seen }], ['reject', { reason: 'Unclear terms', updatedAt: seen }]]) {
    const res = await admin$('PATCH', `/coupon-offers/${offer._id}/${path}`, body);
    assert.equal(res.status, 409, path);
    assert.equal(res.body.code, 'OFFER_CHANGED', path);
  }
  assert.equal((await CouponOffer.findById(offer._id).lean()).status, 'pending_review');

  // With what is on screen now, the decision goes through.
  const fresh = (await admin$('GET', '/coupon-offers?status=pending_review')).body.data.offers[0].updatedAt;
  const ok = await admin$('PATCH', `/coupon-offers/${offer._id}/approve`, { updatedAt: fresh });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.offer.title, 'Changed at the last second');
  assert.equal((await admin$('PATCH', `/coupon-offers/${offer._id}/approve`, { updatedAt: 'yesterday' })).status, 400);
});

test('an approval racing an edit: the approved offer always carries the text that was reviewed', async () => {
  const { headers } = await activeSeller();
  const offer = await createOffer(headers);
  await seller$('POST', `/${offer._id}/submit`, undefined, headers);
  const seen = (await admin$('GET', '/coupon-offers?status=pending_review')).body.data.offers[0].updatedAt;
  const [edit, approve] = await Promise.all([
    seller$('PATCH', `/${offer._id}`, { title: 'Changed at the last second' }, headers),
    admin$('PATCH', `/coupon-offers/${offer._id}/approve`, { updatedAt: seen }),
  ]);
  assert.equal(edit.status, 200, 'the seller can always edit');
  const stored = await CouponOffer.findById(offer._id).lean();
  if (approve.status === 200) {
    // Approved first; the edit then sent it back to review.
    assert.equal(stored.status, 'pending_review');
  } else {
    // Edited first; the stale approval was refused.
    assert.equal(approve.status, 409);
    assert.equal(stored.status, 'pending_review');
  }
  assert.equal(stored.title, 'Changed at the last second');
});

test('one seller can never see or change another seller\'s offers', async () => {
  const a = await activeSeller();
  const b = await activeSeller();
  const theirs = await createOffer(b.headers);
  assert.equal((await seller$('GET', '', undefined, a.headers)).body.data.offers.length, 0);
  for (const [method, path, body] of [
    ['PATCH', `/${theirs._id}`, { title: 'Hijacked offer' }],
    ['POST', `/${theirs._id}/submit`],
    ['POST', `/${theirs._id}/pause`],
    ['POST', `/${theirs._id}/resume`],
  ]) {
    assert.equal((await seller$(method, path, body, a.headers)).status, 404, `${method} ${path}`);
  }
  assert.equal((await CouponOffer.findById(theirs._id).lean()).title, '20% off any haircut');
});

test('offers: employees and unapproved sellers are refused; managers may manage', async () => {
  const { seller } = await activeSeller();
  const manager = await SellerUser.create({ sellerId: seller._id, name: 'M', phone: '9111111111', role: 'manager' });
  const employee = await SellerUser.create({ sellerId: seller._id, name: 'E', phone: '9222222222', role: 'employee' });
  assert.equal((await seller$('POST', '', offerBody(), sellerHeaders(manager))).status, 201);
  assert.equal((await seller$('GET', '', undefined, sellerHeaders(employee))).status, 403);
  assert.equal((await seller$('POST', '', offerBody(), sellerHeaders(employee))).status, 403);
  assert.equal((await seller$('GET', '', undefined, {})).status, 401);

  const pending = await activeSeller({ status: 'pending' });
  const res = await seller$('GET', '', undefined, pending.headers);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SELLER_NOT_ACTIVE');
  assert.equal((await seller$('PATCH', '/nope', { title: 'abcd' }, sellerHeaders(manager))).status, 400);
});

test('the admin offer list filters and pages', async () => {
  const a = await activeSeller();
  const b = await activeSeller();
  await createOffer(a.headers, { title: 'Offer A1' });
  await createOffer(a.headers, { title: 'Offer A2' });
  await createOffer(b.headers, { title: 'Offer B1' });
  assert.equal((await admin$('GET', `/coupon-offers?sellerId=${a.seller._id}`)).body.data.total, 2);
  assert.equal((await admin$('GET', '/coupon-offers?status=draft&limit=2')).body.data.offers.length, 2);
  assert.equal((await admin$('GET', '/coupon-offers?status=draft&limit=2&page=2')).body.data.offers.length, 1);
  assert.equal((await admin$('GET', '/coupon-offers?status=live')).status, 400);
});

test('the signup category list (public) stays available for the dropdown', async () => {
  await makeCategory({ key: 'spa', name: 'Spa', sortOrder: 1 });
  const res = await srv.get('/api/seller/auth/categories');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.categories.map((c) => c.key), ['spa', 'salon']);
});
