// A super admin assigns a complimentary coupon to a mobile number → it shows in that customer's
// app, and the seller can redeem it at the counter. Unassigned complimentary coupons stay hidden
// from sellers and customers. In-memory MongoDB, fake Redis.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const fx = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { default: User } = await import('../models/User.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const CODE = generateCouponCode();

let mongo;
let srv;
let adminH;
let sellerH;
let seller;
let comp;
const redis = fakeRedis();

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Coupon.init(), User.init(), Seller.init()]);
  redemption.__setRedeemRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  redemption.__setRedeemRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetCouponSettingsCache();
  const admin = await User.create({ name: 'Root', email: 'root@test.local', role: 'admin' });
  adminH = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  const made = await fx.makeCompleteSeller({ status: 'active' });
  seller = made.seller;
  sellerH = made.headers;
  const sub = await SellerSubscription.collection.insertOne({ sellerId: seller._id, status: 'active', remaining: 10, issued: 0, activatedAt: new Date(), planSnapshot: { key: 'basic', name: 'Basic' }, payment: { method: 'manual' } });
  comp = await Coupon.create({
    code: CODE,
    kind: 'complimentary',
    sellerId: seller._id,
    subscriptionId: sub.insertedId,
    categoryId: seller.categoryId,
    source: { type: 'plan', id: sub.insertedId },
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });
});

const { default: CouponOffer } = await import('../models/CouponOffer.js');
const assign = (body) => srv.request('PATCH', `/api/admin/coupons/complimentary/${comp._id}/assign`, { headers: adminH, body });
const lookup = (code = CODE) => srv.request('POST', '/api/seller/redeem/lookup', { headers: sellerH, body: { code } });

test('unassigned: the seller cannot see or redeem it', async () => {
  assert.equal((await lookup()).status, 404);
  assert.equal((await srv.request('POST', '/api/seller/redeem', { headers: sellerH, body: { code: CODE } })).status, 404);
});

test('assigned to a new number → a customer account, in their app, and the seller redeems it once', async () => {
  // Complimentary coupons are made at plan purchase with no offer: assigning gives them the
  // seller's first approved offer.
  await CouponOffer.create({ sellerId: seller._id, categoryId: seller.categoryId, title: 'Free haircut', terms: 'Once', status: 'approved', reviewedAt: new Date(Date.now() - 3_600_000) });
  await CouponOffer.create({ sellerId: seller._id, categoryId: seller.categoryId, title: 'Later offer', status: 'approved', reviewedAt: new Date() });
  const res = await assign({ name: 'Neha Gupta', phone: '+91 98200 11223', note: 'Influencer' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const user = await User.findOne({ phone: '9820011223' }).lean();
  assert.ok(user);
  assert.equal(user.role, 'customer');
  assert.equal(user.name, 'Neha Gupta');
  const stored = await Coupon.findById(comp._id).lean();
  assert.equal(String(stored.customerId), String(user._id));
  assert.equal(stored.customerSnapshot.name, 'Neha Gupta');

  // In the customer app.
  const customerH = { authorization: `Bearer ${auth.generateTokens(user._id, 'customer').accessToken}` };
  const mine = await srv.get('/api/users/me/coupons', customerH);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.data.total, 1);
  assert.equal(mine.body.data.coupons[0].code, CODE);
  assert.equal(mine.body.data.coupons[0].kind, 'complimentary');
  assert.equal(mine.body.data.coupons[0].title, 'Free haircut');
  assert.equal((await srv.get(`/api/users/me/coupons/${comp._id}`, customerH)).status, 200);

  // At the seller's counter.
  const seen = await lookup();
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.data.coupon.customerFirstName, 'Neha');
  assert.equal(seen.body.data.coupon.offerTitle, 'Free haircut');
  const redeemed = await srv.request('POST', '/api/seller/redeem', { headers: sellerH, body: { code: CODE, phoneLast4: '1223' } });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  const again = await srv.request('POST', '/api/seller/redeem', { headers: sellerH, body: { code: CODE, phoneLast4: '1223' } });
  assert.equal(again.status, 409, 'exactly once');
  const today = await srv.get('/api/seller/redeem/today', sellerH);
  assert.equal(today.body.data.count, 1);

  // The admin sees it used.
  const list = await srv.get(`/api/admin/coupons/complimentary?seller=${seller._id}`, adminH);
  assert.equal(list.body.data.groups[0].coupons[0].status, 'redeemed');

  // Another seller can never redeem it.
  const other = await fx.makeCompleteSeller({ status: 'active', phone: '9000000077' });
  assert.equal((await srv.request('POST', '/api/seller/redeem/lookup', { headers: other.headers, body: { code: CODE } })).status, 404);
});

test('an existing customer keeps their profile; re-assigning moves it to the new number', async () => {
  const existing = await User.create({ name: 'Raj', phone: '9820011223', role: 'customer' });
  await assign({ name: 'Rajesh Kumar', phone: '9820011223' });
  assert.equal((await User.findById(existing._id).lean()).name, 'Raj', 'never overwritten');
  assert.equal(String((await Coupon.findById(comp._id).lean()).customerId), String(existing._id));

  await assign({ name: 'Meera', phone: '9820099999' });
  const meera = await User.findOne({ phone: '9820099999' }).lean();
  assert.equal(String((await Coupon.findById(comp._id).lean()).customerId), String(meera._id));
  const rajH = { authorization: `Bearer ${auth.generateTokens(existing._id, 'customer').accessToken}` };
  assert.equal((await srv.get('/api/users/me/coupons', rajH)).body.data.total, 0, 'gone from the first person');
});

test('a seller with no approved offer: the coupon still gets a clear title', async () => {
  await assign({ name: 'Neha', phone: '9820011223' });
  const stored = await Coupon.findById(comp._id).lean();
  assert.equal(stored.offerSnapshot.title, 'Complimentary coupon from Glow Salon');
});

test("a restaurant owner's or admin's number is refused", async () => {
  await User.create({ name: 'Owner', email: 'o@test.local', phone: '9820055555', role: 'restaurant_owner' });
  const res = await assign({ name: 'Owner', phone: '9820055555' });
  assert.equal(res.status, 409);
  assert.equal((await Coupon.findById(comp._id).lean()).customerId, null);
});
