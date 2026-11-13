// CB1 — coupon models: required fields, unique indexes, select:false identity fields, immutable
// settings history, settings versioning, and the reference-data seed script.
// In-memory MongoDB; no gateway or SMS involved.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: CouponPlan } = await import('../models/CouponPlan.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SmsCampaign } = await import('../models/SmsCampaign.js');
const { default: SmsLog } = await import('../models/SmsLog.js');
const { default: CouponSettings } = await import('../models/CouponSettings.js');
const settingsService = await import('../services/couponSettings.service.js');
const { getActiveCouponSettings, createCouponSettingsVersion, listCouponSettingsVersions, __resetCouponSettingsCache } =
  settingsService;
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { SEED_COUPON_SETTINGS } = await import('../config/coupon.config.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { encryptField } = await import('../utils/fieldEncryption.js');

const MODELS = [Seller, SellerUser, CouponCategory, CouponPlan, SellerSubscription, CouponOffer, Coupon, SmsCampaign, SmsLog, CouponSettings];

let mongo;
before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all(MODELS.map((M) => M.init()));
});
after(async () => {
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetCouponSettingsCache();
});

const isDuplicate = (err) => err?.code === 11000;
const silent = () => {};

// Minimal valid rows, overridable per test.
const makeCategory = (over = {}) => CouponCategory.create({ key: 'salon', name: 'Salon', ...over });
const makeSeller = async (over = {}) => {
  const category = over.categoryId ? null : await makeCategory({ key: `cat-${new mongoose.Types.ObjectId()}` });
  return Seller.create({ businessName: 'Glow Salon', categoryId: category?._id, ...over });
};
const makeSubscription = (sellerId, over = {}) =>
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
      couponAllocation: 250,
      complimentaryCount: 5,
    },
    payment: { method: 'razorpay' },
    ...over,
  });
const makeCoupon = (seller, subscription, over = {}) =>
  Coupon.create({
    code: generateCouponCode(),
    kind: 'customer',
    sellerId: seller._id,
    subscriptionId: subscription._id,
    categoryId: seller.categoryId,
    source: { type: 'manual' },
    expiresAt: new Date(Date.now() + 30 * 864e5),
    ...over,
  });

// ── Seller & SellerUser ───────────────────────────────────────────────────────

test('a new seller starts pending with no location and zero SMS credits', async () => {
  const seller = await makeSeller();
  assert.equal(seller.status, 'pending');
  assert.equal(seller.location, undefined);
  assert.equal(seller.smsCreditsBalance, 0);
  const raw = await mongoose.connection.collection('sellers').findOne({ _id: seller._id });
  assert.equal('location' in raw, false, 'no empty Point may be stored');
});

test('a seller location must be a full [lng, lat] point and is geo-queryable', async () => {
  await assert.rejects(makeSeller({ location: { type: 'Point', coordinates: [] } }), /coordinates/);
  const near = await makeSeller({ location: { type: 'Point', coordinates: [77.59, 12.97] } });
  await makeSeller({ location: { type: 'Point', coordinates: [72.88, 19.07] } }); // ~850 km away
  const found = await Seller.find({
    location: { $nearSphere: { $geometry: { type: 'Point', coordinates: [77.6, 12.98] }, $maxDistance: 10_000 } },
  }).lean();
  assert.deepEqual(found.map((s) => String(s._id)), [String(near._id)]);
});

test('PAN and Aadhaar ciphertext are never returned unless asked for', async () => {
  const seller = await makeSeller({
    owner: { name: 'Asha', panEncrypted: encryptField('ABCDE1234F'), panLast4: '234F', aadhaarLast4: '9012' },
  });
  const plain = await Seller.findById(seller._id).lean();
  assert.equal(plain.owner.panEncrypted, undefined);
  assert.equal(plain.owner.aadhaarEncrypted, undefined);
  assert.equal(plain.owner.panLast4, '234F');
  const withSecret = await Seller.findById(seller._id).select('+owner.panEncrypted').lean();
  assert.match(withSecret.owner.panEncrypted, /^v1:/);
  assert.ok(!withSecret.owner.panEncrypted.includes('ABCDE1234F'));
});

test('seller status and document type are restricted to the known values', async () => {
  await assert.rejects(makeSeller({ status: 'approved' }), /status/);
  await assert.rejects(makeSeller({ documents: [{ type: 'passport' }] }), /type/);
});

test('one active login per phone per seller; deactivated rows free the phone', async () => {
  const seller = await makeSeller();
  const other = await makeSeller();
  await SellerUser.create({ sellerId: seller._id, name: 'Asha', phone: '9000000001', role: 'owner' });
  await assert.rejects(
    SellerUser.create({ sellerId: seller._id, name: 'Asha 2', phone: '9000000001', role: 'manager' }),
    isDuplicate
  );
  // The same person may work for another seller.
  await SellerUser.create({ sellerId: other._id, name: 'Asha', phone: '9000000001', role: 'employee' });
  // After deactivation the phone can be added again.
  await SellerUser.updateOne({ sellerId: seller._id, phone: '9000000001' }, { isActive: false });
  await SellerUser.create({ sellerId: seller._id, name: 'Asha again', phone: '9000000001', role: 'employee' });
});

test('seller user roles and gender are restricted; the password hash never serialises', async () => {
  const seller = await makeSeller();
  await assert.rejects(SellerUser.create({ sellerId: seller._id, name: 'X', phone: '9000000002', role: 'admin' }), /role/);
  await assert.rejects(
    SellerUser.create({ sellerId: seller._id, name: 'X', phone: '9000000002', role: 'employee', gender: 'unknown' }),
    /gender/
  );
  const user = await SellerUser.create({ sellerId: seller._id, name: 'X', phone: '9000000002', role: 'employee', passwordHash: 'h' });
  assert.equal(user.toJSON().passwordHash, undefined);
  assert.equal((await SellerUser.findById(user._id).lean()).passwordHash, undefined);
});

// ── Categories, plans, offers ─────────────────────────────────────────────────

test('category and plan keys are unique; categories start disabled', async () => {
  const category = await makeCategory();
  assert.equal(category.enabled, false);
  await assert.rejects(makeCategory({ name: 'Salon again' }), isDuplicate);
  await assert.rejects(makeCategory({ key: 'SALON', name: 'Upper case' }), isDuplicate); // keys are lower-cased

  const plan = { key: 'basic', name: 'Basic', basePricePaise: 500_000, gstPercent: 18, couponAllocation: 250, complimentaryCount: 5 };
  await CouponPlan.create(plan);
  await assert.rejects(CouponPlan.create(plan), isDuplicate);
});

test('plan prices and counts must be whole numbers', async () => {
  const base = { name: 'X', gstPercent: 18, complimentaryCount: 5 };
  await assert.rejects(CouponPlan.create({ ...base, key: 'a', basePricePaise: 500_000.5, couponAllocation: 250 }));
  await assert.rejects(CouponPlan.create({ ...base, key: 'b', basePricePaise: 500_000, couponAllocation: 0 }));
  await assert.rejects(CouponPlan.create({ ...base, key: 'c', basePricePaise: -1, couponAllocation: 250 }));
});

test('offers start as drafts and validity is bounded', async () => {
  const seller = await makeSeller();
  const offer = await CouponOffer.create({ sellerId: seller._id, categoryId: seller.categoryId, title: '20% off haircut' });
  assert.equal(offer.status, 'draft');
  assert.equal(offer.validityDays, null);
  await assert.rejects(CouponOffer.create({ sellerId: seller._id, categoryId: seller.categoryId, title: 'x', validityDays: 0 }));
  await assert.rejects(CouponOffer.create({ sellerId: seller._id, categoryId: seller.categoryId, title: 'x', validityDays: 400 }));
});

// ── Subscriptions ─────────────────────────────────────────────────────────────

test('subscriptions start pending payment with empty stock', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id);
  assert.equal(sub.status, 'pending_payment');
  assert.equal(sub.allocated, 0);
  assert.equal(sub.remaining, 0);
});

test('a Razorpay order or payment id can belong to only one subscription', async () => {
  const seller = await makeSeller();
  await makeSubscription(seller._id, { payment: { method: 'razorpay', razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1' } });
  await assert.rejects(makeSubscription(seller._id, { payment: { method: 'razorpay', razorpayOrderId: 'order_1' } }), isDuplicate);
  await assert.rejects(makeSubscription(seller._id, { payment: { method: 'razorpay', razorpayPaymentId: 'pay_1' } }), isDuplicate);
  // Manual payments carry neither and never collide.
  await makeSubscription(seller._id, { payment: { method: 'manual' } });
  await makeSubscription(seller._id, { payment: { method: 'manual' } });
});

test('stock can never go below zero', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id, { status: 'active', allocated: 1, remaining: 1 });
  sub.remaining = -1;
  await assert.rejects(sub.save(), /remaining/);
});

// ── Coupons ───────────────────────────────────────────────────────────────────

test('coupon codes are unique', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id);
  const first = await makeCoupon(seller, sub);
  await assert.rejects(makeCoupon(seller, sub, { code: first.code }), isDuplicate);
});

test('issueKey stops a paid order issuing the same category twice, and is optional otherwise', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id);
  const orderId = new mongoose.Types.ObjectId();
  const issueKey = `order:${orderId}:${seller.categoryId}`;
  await makeCoupon(seller, sub, { source: { type: 'order', id: orderId }, issueKey });
  await assert.rejects(makeCoupon(seller, sub, { source: { type: 'order', id: orderId }, issueKey }), isDuplicate);
  // Complimentary and manual coupons have no issueKey, any number of them.
  for (let i = 0; i < 3; i += 1) {
    await makeCoupon(seller, sub, { kind: 'complimentary', source: { type: 'plan', id: sub._id } });
  }
  const raw = await mongoose.connection.collection('coupons').findOne({ kind: 'complimentary' });
  assert.equal('issueKey' in raw, false, 'an absent issueKey must not be stored as null');
});

test('coupon kind, status and source type are restricted', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id);
  await assert.rejects(makeCoupon(seller, sub, { kind: 'staff' }), /kind/);
  await assert.rejects(makeCoupon(seller, sub, { status: 'used' }), /status/);
  await assert.rejects(makeCoupon(seller, sub, { source: { type: 'gift' } }), /type/);
  const fresh = await makeCoupon(seller, sub);
  assert.equal(fresh.status, 'issued');
});

test('a coupon cannot be redeemed twice by a conditional update', async () => {
  const seller = await makeSeller();
  const sub = await makeSubscription(seller._id);
  const coupon = await makeCoupon(seller, sub);
  const redeem = () =>
    Coupon.findOneAndUpdate(
      { _id: coupon._id, status: 'issued' },
      { $set: { status: 'redeemed', redeemedAt: new Date() } },
      { new: true }
    );
  const results = await Promise.all(Array.from({ length: 10 }, redeem));
  assert.equal(results.filter(Boolean).length, 1);
});

// ── SMS ───────────────────────────────────────────────────────────────────────

test('one SMS log per coupon per campaign', async () => {
  const campaign = await SmsCampaign.create({ createdBy: { kind: 'system' }, unitPricePaise: 300, gstPercent: 18 });
  const couponId = new mongoose.Types.ObjectId();
  await SmsLog.create({ campaignId: campaign._id, couponId, phone: '9000000001' });
  await assert.rejects(SmsLog.create({ campaignId: campaign._id, couponId, phone: '9000000001' }), isDuplicate);
  await assert.rejects(SmsCampaign.create({ createdBy: { kind: 'robot' }, unitPricePaise: 300, gstPercent: 18 }), /kind/);
});

// ── Coupon settings ───────────────────────────────────────────────────────────

test('first read seeds version 1 with the agreed defaults, once', async () => {
  assert.equal(await CouponSettings.countDocuments(), 0);
  const s = await getActiveCouponSettings();
  assert.equal(s.version, 1);
  for (const [key, value] of Object.entries(SEED_COUPON_SETTINGS)) assert.deepEqual(s[key], value, key);
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.smsCreditPackSizes));

  __resetCouponSettingsCache();
  await Promise.all([getActiveCouponSettings(), getActiveCouponSettings(), getActiveCouponSettings()]);
  assert.equal(await CouponSettings.countDocuments(), 1);
});

test('a change is a new version; history is immutable', async () => {
  const admin = new mongoose.Types.ObjectId();
  const { version, changes } = await createCouponSettingsVersion({ patch: { perOrderCap: 2 }, note: 'client said 2' }, admin);
  assert.equal(version.version, 2);
  assert.deepEqual(changes, [{ field: 'perOrderCap', from: 3, to: 2 }]);
  assert.equal((await getActiveCouponSettings()).perOrderCap, 2, 'the cache is cleared on save');
  assert.equal((await getActiveCouponSettings()).radiusKm, SEED_COUPON_SETTINGS.radiusKm, 'unpatched fields carry over');

  const versions = await listCouponSettingsVersions();
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  assert.equal(String(versions[0].createdBy), String(admin));

  await assert.rejects(CouponSettings.updateOne({ version: 1 }, { perOrderCap: 9 }), /immutable/);
  await assert.rejects(CouponSettings.deleteOne({ version: 1 }), /immutable/);
  const v1 = await CouponSettings.findOne({ version: 1 });
  v1.perOrderCap = 9;
  await assert.rejects(v1.save(), /immutable/);
});

test('settings changes are validated', async () => {
  const bad = [
    { perOrderCap: 0 },
    { perOrderCap: 2.5 },
    { defaultValidityDays: 3000 },
    { smsPricePaise: 300.5 },
    { smsGstPercent: 50 },
    { smsCreditPackSizes: [] },
    { smsCreditPackSizes: [100, 100] },
    { unknownField: 1 },
  ];
  for (const patch of bad) {
    await assert.rejects(createCouponSettingsVersion({ patch }), (err) => err.code === 'VALIDATION_ERROR', JSON.stringify(patch));
  }
  await assert.rejects(
    createCouponSettingsVersion({ patch: { perOrderCap: SEED_COUPON_SETTINGS.perOrderCap } }),
    (err) => err.code === 'NO_CHANGES'
  );
});

test('two admins saving at once both land as separate versions', async () => {
  await getActiveCouponSettings();
  const results = await Promise.all([
    createCouponSettingsVersion({ patch: { perOrderCap: 2 } }),
    createCouponSettingsVersion({ patch: { radiusKm: 15 } }),
  ]);
  assert.deepEqual(results.map((r) => r.version.version).sort(), [2, 3]);
  const latest = await CouponSettings.findOne().sort({ version: -1 }).lean();
  assert.equal(latest.perOrderCap, 2);
  assert.equal(latest.radiusKm, 15);
});

// ── Seed script ───────────────────────────────────────────────────────────────

test('the seed script dry-runs by default and writes nothing', async () => {
  const result = await seedCouponData({ log: silent });
  assert.deepEqual(result, { plansCreated: 0, categoriesCreated: 0, settingsSeeded: false });
  assert.equal(await CouponPlan.countDocuments(), 0);
  assert.equal(await CouponCategory.countDocuments(), 0);
  assert.equal(await CouponSettings.countDocuments(), 0);
});

test('the seed script creates plans, disabled categories and settings once, and never overwrites', async () => {
  const first = await seedCouponData({ apply: true, log: silent });
  assert.deepEqual(first, { plansCreated: 3, categoriesCreated: 5, settingsSeeded: true });
  assert.equal(await CouponCategory.countDocuments({ enabled: true }), 0);

  // An admin edits a plan and enables a category; a re-run must leave both alone.
  await CouponPlan.updateOne({ key: 'basic' }, { basePricePaise: 450_000 });
  await CouponCategory.updateOne({ key: 'spa' }, { enabled: true });
  const second = await seedCouponData({ apply: true, log: silent });
  assert.deepEqual(second, { plansCreated: 0, categoriesCreated: 0, settingsSeeded: false });
  assert.equal((await CouponPlan.findOne({ key: 'basic' }).lean()).basePricePaise, 450_000);
  assert.equal((await CouponCategory.findOne({ key: 'spa' }).lean()).enabled, true);
  assert.equal(await CouponPlan.countDocuments(), 3);
  assert.equal(await CouponCategory.countDocuments(), 5);
  assert.equal(await CouponSettings.countDocuments(), 1);

  const ledger = await mongoose.connection.collection('migrations_applied').find({ name: 'seedCouponData' }).toArray();
  assert.equal(ledger.length, 1, 'only the run that wrote something is recorded');
});

test('a missing plan or category is filled in without touching the rest', async () => {
  await seedCouponData({ apply: true, log: silent });
  await CouponPlan.deleteOne({ key: 'plus' });
  await CouponCategory.deleteOne({ key: 'grocery' });
  const result = await seedCouponData({ apply: true, log: silent });
  assert.deepEqual(result, { plansCreated: 1, categoriesCreated: 1, settingsSeeded: false });
});
