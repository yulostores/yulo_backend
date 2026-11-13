// CB7 — redeeming a coupon at the seller's counter: lookup, exactly-once redeem under parallel
// taps, every refusal reason, cross-seller probing, the optional phone check, roles and seller
// status, the per-user rate limit and the wrong-code lockout, and today's list. In-memory MongoDB,
// in-memory Redis stand-in; everything through HTTP.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller, sellerHeaders } = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const { __resetCouponSettingsCache, createCouponSettingsVersion } = await import('../services/couponSettings.service.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { SELLER_REDEEM_LIMIT } = await import('../middleware/rateLimiter.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: User } = await import('../models/User.js');

const redis = fakeRedis();
let mongo;
let srv;
let category;
let customer;
let shop; // { seller, owner, headers }
let phoneN = 0;

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
  redemption.__setRedeemRedisForTests(redis);
  __resetCouponSettingsCache();
  category = await makeCategory({ key: 'salon', name: 'Salon', enabled: true });
  customer = await User.create({ name: 'Priya Sharma', phone: '9876543210', role: 'customer' });
  shop = await newShop();
});

const newShop = async (status = 'active') => {
  phoneN += 1;
  return makeCompleteSeller({ status, categoryId: category._id, phone: `96${String(phoneN).padStart(8, '0')}` });
};
const staff = async (sellerId, role, name = `${role} one`) => {
  phoneN += 1;
  const user = await SellerUser.create({ sellerId, name, phone: `97${String(phoneN).padStart(8, '0')}`, role });
  return { user, headers: sellerHeaders(user) };
};

const coupon = (over = {}) =>
  Coupon.create({
    code: generateCouponCode(),
    kind: 'customer',
    sellerId: shop.seller._id,
    subscriptionId: new mongoose.Types.ObjectId(),
    offerId: new mongoose.Types.ObjectId(),
    offerSnapshot: { title: '20% off any haircut', terms: 'Weekdays only' },
    categoryId: category._id,
    customerId: customer._id,
    customerSnapshot: { name: 'Priya Sharma', gender: 'female', dateOfBirth: new Date('1994-03-02') },
    source: { type: 'order', id: new mongoose.Types.ObjectId() },
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
    ...over,
  });

// Every response body any test sees, checked at the end of each test for customer details.
let bodies = [];
beforeEach(() => {
  bodies = [];
});
const call = async (method, path, body, headers = shop.headers) => {
  const res = await srv.request(method, `/api/seller/redeem${path}`, { body, headers });
  bodies.push(res.body);
  return res;
};
const lookup = (code, headers) => call('POST', '/lookup', { code }, headers);
const redeem = (code, extra = {}, headers) => call('POST', '', { code, ...extra }, headers);

const assertNoCustomerDetails = () => {
  const text = JSON.stringify(bodies);
  assert.ok(!text.includes('9876543210'), 'phone number leaked');
  assert.ok(!text.includes(String(customer._id)), 'customer id leaked');
  assert.ok(!/customerId|"phone"|dateOfBirth|subscriptionId/.test(text), 'internal field leaked');
};

const settings = (patch) =>
  createCouponSettingsVersion({ patch, note: 'test' }, new mongoose.Types.ObjectId()).then(() => __resetCouponSettingsCache());

// ── Happy path ────────────────────────────────────────────────────────────────

test('lookup then redeem: first name only, recorded with who and when, listed today', async () => {
  const c = await coupon();
  // People type codes with dashes, spaces and in lower case.
  const typed = `${c.code.slice(0, 5).toLowerCase()}-${c.code.slice(5)} `;

  const found = await lookup(typed);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(
    { ...found.body.data.coupon, issuedAt: undefined, expiresAt: undefined },
    {
      code: c.code,
      offerTitle: '20% off any haircut',
      terms: 'Weekdays only',
      category: 'Salon',
      customerFirstName: 'Priya',
      issuedAt: undefined,
      expiresAt: undefined,
      status: 'issued',
      needsPhoneCheck: false,
    }
  );
  assert.ok(found.body.data.coupon.issuedAt && found.body.data.coupon.expiresAt);

  const done = await redeem(typed);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.coupon.status, 'redeemed');
  assert.equal(done.body.data.coupon.redeemedByName, 'Asha Rao');

  const saved = await Coupon.findById(c._id).lean();
  assert.equal(saved.status, 'redeemed');
  assert.equal(String(saved.redeemedBy), String(shop.owner._id));
  assert.ok(saved.redeemedAt);

  const again = await lookup(c.code);
  assert.equal(again.body.data.coupon.status, 'redeemed');
  assert.equal(again.body.data.coupon.redeemedByName, 'Asha Rao');

  const today = await call('GET', '/today');
  assert.equal(today.status, 200);
  assert.equal(today.body.data.count, 1);
  assert.equal(today.body.data.redemptions[0].code, c.code);
  assert.equal(today.body.data.redemptions[0].customerFirstName, 'Priya');
  assertNoCustomerDetails();
});

test('20 parallel redeems of one code → exactly one success, the rest name who redeemed it', async () => {
  const c = await coupon();
  const counters = [shop.headers];
  for (let i = 0; i < 3; i += 1) counters.push((await staff(shop.seller._id, 'employee', `Counter ${i}`)).headers);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => redeem(c.code, {}, counters[i % counters.length])));
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, results.map((r) => r.status).join(','));
  for (const r of results.filter((x) => x.status !== 200)) {
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'COUPON_ALREADY_REDEEMED');
    assert.equal(r.body.details.redeemedByName, ok[0].body.data.coupon.redeemedByName);
    assert.ok(r.body.details.redeemedAt);
  }
  assertNoCustomerDetails();
});

// ── Refusals ──────────────────────────────────────────────────────────────────

test('expired: past its date (before or after the expiry job) → 410; lookup says expired', async () => {
  const pastDate = await coupon({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await lookup(pastDate.code)).body.data.coupon.status, 'expired');
  const res = await redeem(pastDate.code);
  assert.equal(res.status, 410);
  assert.equal(res.body.code, 'COUPON_EXPIRED');
  assert.equal((await Coupon.findById(pastDate._id).lean()).status, 'issued', 'untouched');

  const marked = await coupon({ status: 'expired', expiresAt: new Date(Date.now() - 86_400_000) });
  assert.equal((await redeem(marked.code)).status, 410);
  assertNoCustomerDetails();
});

test('void (the order was refunded) → 409 COUPON_VOID', async () => {
  const c = await coupon({ status: 'void', voidedAt: new Date(), voidReason: 'Payment refunded' });
  assert.equal((await lookup(c.code)).body.data.coupon.status, 'void');
  const res = await redeem(c.code);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'COUPON_VOID');
  assertNoCustomerDetails();
});

test("another seller's code and a complimentary coupon answer exactly like a code that doesn't exist", async () => {
  const other = await newShop();
  const theirs = await coupon({ sellerId: other.seller._id });
  const complimentary = await coupon({ kind: 'complimentary', customerId: null, source: { type: 'plan', id: new mongoose.Types.ObjectId() } });

  const unknown = await lookup('ABCDEFGHJK');
  assert.equal(unknown.status, 404);
  for (const code of [theirs.code, complimentary.code, 'not a code']) {
    for (const res of [await lookup(code), await redeem(code)]) {
      assert.equal(res.status, 404, code);
      assert.deepEqual(res.body, unknown.body, 'same answer, nothing to probe');
    }
  }
  assert.equal((await Coupon.findById(theirs._id).lean()).status, 'issued');
  assert.equal((await Coupon.findById(complimentary._id).lean()).status, 'issued');
  // The owning seller can redeem their own.
  assert.equal((await redeem(theirs.code, {}, other.headers)).status, 200);
  assertNoCustomerDetails();
});

test('phone check: wrong digits → 422 with nothing about the real number; right digits redeem; the setting makes it required', async () => {
  const c = await coupon();
  const wrong = await redeem(c.code, { phoneLast4: '1111' });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, 'PHONE_MISMATCH');
  assert.equal(wrong.body.details, undefined);
  assert.equal((await Coupon.findById(c._id).lean()).status, 'issued');
  assert.equal((await redeem(c.code, { phoneLast4: 'abcd' })).status, 400);
  assert.equal((await redeem(c.code, { phoneLast4: '3210' })).status, 200);

  await settings({ phoneCheckRequired: true });
  const c2 = await coupon();
  assert.equal((await lookup(c2.code)).body.data.coupon.needsPhoneCheck, true);
  const missing = await redeem(c2.code);
  assert.equal(missing.status, 422);
  assert.equal(missing.body.code, 'PHONE_CHECK_REQUIRED');
  assert.equal((await redeem(c2.code, { phoneLast4: '3210' })).status, 200);

  // Saving another setting keeps the phone check on.
  await settings({ perOrderCap: 2 });
  const c3 = await coupon();
  assert.equal((await lookup(c3.code)).body.data.coupon.needsPhoneCheck, true);
  assertNoCustomerDetails();
});

// ── Roles and seller status ───────────────────────────────────────────────────

test('employees and managers redeem; today: an employee sees their own, the owner and manager see everyone', async () => {
  const employee = await staff(shop.seller._id, 'employee', 'Ravi Kumar');
  const manager = await staff(shop.seller._id, 'manager', 'Meera');
  const [a, b, c] = [await coupon(), await coupon(), await coupon()];
  assert.equal((await redeem(a.code, {}, employee.headers)).status, 200);
  assert.equal((await redeem(b.code, {}, manager.headers)).status, 200);
  assert.equal((await redeem(c.code)).status, 200);
  // Yesterday's redemption isn't today's.
  await coupon({ status: 'redeemed', redeemedAt: new Date(Date.now() - 2 * 86_400_000), redeemedBy: employee.user._id });

  const mine = await call('GET', '/today', undefined, employee.headers);
  assert.equal(mine.body.data.scope, 'mine');
  assert.deepEqual(mine.body.data.redemptions.map((r) => r.code), [a.code]);
  assert.equal(mine.body.data.redemptions[0].redeemedByName, 'Ravi Kumar');

  for (const headers of [shop.headers, manager.headers]) {
    const all = await call('GET', '/today', undefined, headers);
    assert.equal(all.body.data.scope, 'business');
    assert.equal(all.body.data.count, 3);
    assert.deepEqual(new Set(all.body.data.redemptions.map((r) => r.redeemedByName)), new Set(['Ravi Kumar', 'Meera', 'Asha Rao']));
  }
  assertNoCustomerDetails();
});

test('a suspended or pending seller cannot look up or redeem; no token → 401', async () => {
  const c = await coupon();
  for (const status of ['suspended', 'pending']) {
    const s = await newShop(status);
    await Coupon.updateOne({ _id: c._id }, { $set: { sellerId: s.seller._id } });
    for (const res of [await lookup(c.code, s.headers), await redeem(c.code, {}, s.headers), await call('GET', '/today', undefined, s.headers)]) {
      assert.equal(res.status, 403, status);
      assert.equal(res.body.code, 'SELLER_NOT_ACTIVE');
    }
  }
  assert.equal((await Coupon.findById(c._id).lean()).status, 'issued');
  assert.equal((await lookup(c.code, {})).status, 401);
});

// ── Abuse ─────────────────────────────────────────────────────────────────────

test(`rate limit: ${SELLER_REDEEM_LIMIT} lookups + redeems a minute per login, then 429; another login is unaffected`, async () => {
  const c = await coupon();
  const counter = await staff(shop.seller._id, 'employee');
  for (let i = 0; i < SELLER_REDEEM_LIMIT; i += 1) {
    const res = await lookup(c.code, counter.headers);
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const limited = await redeem(c.code, {}, counter.headers);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal((await redeem(c.code)).status, 200, 'the owner at another counter still works');
});

test('lockout: repeated wrong codes (or digits) pause that login; the whole shop pauses past the shop limit', async () => {
  const c = await coupon();
  const first = await staff(shop.seller._id, 'employee', 'Guesser');
  for (let i = 0; i < redemption.REDEEM_LOCKOUT.perUser - 1; i += 1) {
    assert.equal((await lookup(generateCouponCode(), first.headers)).status, 404);
  }
  // A wrong phone check counts too.
  assert.equal((await redeem(c.code, { phoneLast4: '0000' }, first.headers)).body.code, 'PHONE_MISMATCH');
  const locked = await lookup(c.code, first.headers);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, 'REDEEM_LOCKED');
  assert.equal((await redeem(c.code, {}, first.headers)).status, 429, 'even the right code, for now');

  // Others in the shop keep working until the shop-wide count is reached.
  const remaining = redemption.REDEEM_LOCKOUT.perSeller - redemption.REDEEM_LOCKOUT.perUser;
  const others = [];
  for (let i = 0; i < 3; i += 1) others.push(await staff(shop.seller._id, 'employee', `Other ${i}`));
  for (let i = 0; i < remaining; i += 1) {
    assert.equal((await lookup(generateCouponCode(), others[i % 3].headers)).status, 404, `shop guess ${i + 1}`);
  }
  const shopLocked = await lookup(c.code, shop.headers);
  assert.equal(shopLocked.status, 429);
  assert.equal(shopLocked.body.code, 'REDEEM_LOCKED');

  // Another business is unaffected, and the lock lifts when the window passes.
  const other = await newShop();
  const theirs = await coupon({ sellerId: other.seller._id });
  assert.equal((await lookup(theirs.code, other.headers)).status, 200);
  redis.clear();
  assert.equal((await redeem(c.code)).status, 200);
});

test('without Redis the lockout still works in this process', async () => {
  redemption.__setRedeemRedisForTests(null);
  const c = await coupon();
  const guesser = await staff(shop.seller._id, 'employee');
  for (let i = 0; i < redemption.REDEEM_LOCKOUT.perUser; i += 1) await lookup(generateCouponCode(), guesser.headers);
  assert.equal((await lookup(c.code, guesser.headers)).body.code, 'REDEEM_LOCKED');
});
