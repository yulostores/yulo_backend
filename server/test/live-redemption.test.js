// Live customer activity — A5: personal offers on the customer side. Validation with the
// personal error codes, the saving maths (eligible items, caps, rounding), apply / remove,
// re-validation on cart reads (offerIssue), the customer's offer list and "viewed", exactly-once
// redemption under parallel checkouts / retries / failures, release on every pre-acceptance
// cancellation, and settlement on the discounted food base.
// In-memory MongoDB, the real HTTP API, a fake Razorpay and a fake clock.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const { releaseOfferForCancelledOrder } = await import('../services/personalOffer.service.js');
const { expireUnansweredOrders } = await import('../services/orderApproval.service.js');
const { computeRestaurantSettlementLine } = await import('../services/settlementMath.service.js');
const { getActiveSettings, __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { generateTokens } = await import('../services/auth.service.js');
const { env } = await import('../config/env.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: Order } = await import('../models/Order.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: User } = await import('../models/User.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');
const { ObjectId, authHeader, makeDeliveryCustomer, makeGuest, makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

const MINUTE = 60 * 1000;

let mongo;
let srv;
let t;

const call = async (method, path, user, body, extraHeaders = {}) => {
  const res = await srv.request(method, path, { headers: { ...(user ? authHeader(user) : {}), ...extraHeaders }, body });
  await activity.__flushForTests();
  return res;
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};
const expectError = (res, status, code) => {
  assert.equal(res.status, status, `${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, code);
  return res.body;
};

const enableCod = async () => {
  const admin = await User.create({ name: 'Admin', email: `admin${Date.now()}@test.local`, role: 'admin' });
  ok(
    await srv.request('POST', '/api/admin/finance/settings', {
      headers: { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` },
      body: { settings: { codEnabled: true }, note: 'COD for redemption tests' },
    }),
    201
  );
};

/** A restaurant (paneer ₹250, naan ₹40), a customer who can check out, and helpers. */
const setup = async () => {
  const fixtures = await makeRestaurant();
  const customer = await makeDeliveryCustomer();
  return { ...fixtures, customer };
};

/** An open personal offer for `customer` at `restaurant` (10% up to ₹100, 30 min). */
const makeOffer = ({ restaurant, customer }, overrides = {}) =>
  Discount.create({
    restaurantId: restaurant._id,
    offerName: 'Just for you',
    type: 'percentage',
    percentage: 10,
    maxDiscountAmount: 100,
    minimumOrderValue: 0,
    kind: 'personal',
    targetUserId: customer._id,
    offerStatus: 'sent',
    isOpen: true,
    status: 'active',
    applicableTo: 'delivery',
    maxRedemptions: 1,
    redemptionCount: 0,
    startDate: new Date(t - MINUTE),
    endDate: new Date(t + 30 * MINUTE),
    createdAt: new Date(t - MINUTE),
    ...overrides,
  });

const add = async (customer, item, qty = 1) => ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(item._id), qty }), 201);
const applyOffer = (customer, offer) => call('POST', '/api/cart/apply-offer', customer, { offerId: String(offer._id) });
const checkout = (customer, body = {}, key) =>
  call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod', ...body }, key ? { 'Idempotency-Key': key } : {});
const offerNow = (offer) => Discount.findById(offer._id).lean();

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Discount.init(), IdempotencyKey.init(), CustomerSession.init(), ActivityEvent.init()]);
  __setRazorpayForTests(createFakeRazorpay());
  srv = await startTestServer({ withSocket: true });
});

after(async () => {
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  // The fake clock starts at the real time, so code that still reads Date.now() (order
  // timestamps, the approval sweep) and the feature's clock agree until a test moves it.
  t = Date.now();
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
  activity.__resetWindowsForTests();
  await enableCod();
});

// ─── Apply ─────────────────────────────────────────────────────────────────

describe('apply-offer', () => {
  test('happy path: the bill carries the discount to the paisa; the offer is applied; an event is recorded', async () => {
    const f = await setup();
    const offer = await makeOffer(f, { applicableItems: [f.paneer._id], maxDiscountAmount: 30 });
    await add(f.customer, f.paneer, 2);
    await add(f.customer, f.naan, 1);

    const res = await applyOffer(f.customer, offer);
    const data = ok(res);
    assert.equal(res.body.message, 'Offer applied');
    assert.deepEqual(Object.keys(data), ['cart', 'bill'], 'same shape as every cart endpoint');
    // 10% of the paneer lines (₹500) is ₹50, capped at ₹30. The naan isn't eligible.
    assert.equal(data.bill.charges.food.discount, 3000);
    assert.equal(data.bill.discountAmount, 30);
    assert.equal(String(data.cart.appliedDiscountId), String(offer._id));
    assert.equal(data.bill.offerIssue, undefined);

    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'applied');
    assert.equal(stored.appliedAt.getTime(), t);
    const events = await ActivityEvent.find({ type: 'offer_applied' }).lean();
    assert.equal(events.length, 1);
    assert.equal(String(events[0].data.offerId), String(offer._id));
  });

  test('every refusal has its code: wrong user, other restaurant, expired, revoked, used, items, minimum', async () => {
    const f = await setup();
    const other = await makeRestaurant({ name: 'Elsewhere' });
    const stranger = await makeDeliveryCustomer();
    await add(f.customer, f.paneer, 2); // ₹500

    const mineElsewhere = await makeOffer({ restaurant: other.restaurant, customer: f.customer });
    const someoneElses = await makeOffer({ restaurant: f.restaurant, customer: stranger });
    expectError(await applyOffer(f.customer, someoneElses), 404, 'OFFER_NOT_FOUND');
    expectError(await applyOffer(f.customer, { _id: new ObjectId() }), 404, 'OFFER_NOT_FOUND');
    expectError(await applyOffer(f.customer, mineElsewhere), 400, 'OFFER_NOT_APPLICABLE');

    // Still open but past its end (the sweeper hasn't run yet).
    const expired = await makeOffer(f, { endDate: new Date(t - MINUTE) });
    expectError(await applyOffer(f.customer, expired), 409, 'OFFER_EXPIRED');
    await Discount.updateOne({ _id: expired._id }, { $set: { isOpen: false } });
    const revoked = await makeOffer(f, { offerStatus: 'revoked', isOpen: false, status: 'expired' });
    expectError(await applyOffer(f.customer, revoked), 409, 'OFFER_EXPIRED');
    const used = await makeOffer(f, { offerStatus: 'redeemed', isOpen: false, status: 'expired', redemptionCount: 1 });
    expectError(await applyOffer(f.customer, used), 409, 'OFFER_ALREADY_USED');

    // One open offer per restaurant: close the others as each case is set up.
    await Discount.updateMany({}, { $set: { isOpen: false } });
    const naanOnly = await makeOffer(f, { applicableItems: [f.naan._id] });
    expectError(await applyOffer(f.customer, naanOnly), 400, 'OFFER_NOT_APPLICABLE');
    await Discount.updateMany({}, { $set: { isOpen: false } });
    const minimum = await makeOffer(f, { minimumOrderValue: 620 });
    const body = expectError(await applyOffer(f.customer, minimum), 400, 'DISCOUNT_MIN_VALUE');
    assert.equal(body.details.shortfallPaise, 12000, '₹120 more');

    assert.equal((await Cart.findOne({ userId: f.customer._id }).lean()).appliedDiscountId, null, 'nothing applied');
  });

  test('a cart for another restaurant, or an empty cart → OFFER_NOT_APPLICABLE', async () => {
    const f = await setup();
    const other = await makeRestaurant({ name: 'Elsewhere' });
    const offer = await makeOffer(f);
    expectError(await applyOffer(f.customer, offer), 400, 'OFFER_NOT_APPLICABLE');
    await add(f.customer, other.paneer);
    expectError(await applyOffer(f.customer, offer), 400, 'OFFER_NOT_APPLICABLE');
  });

  test('applying replaces a promo code (and says so); a code replaces the offer, which goes back to viewed', async () => {
    const f = await setup();
    await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Code', type: 'flat_amount', flatAmount: 20, code: 'TWENTY', status: 'active' });
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await call('POST', '/api/cart/apply-promo', f.customer, { code: 'TWENTY' }));

    const res = await applyOffer(f.customer, offer);
    assert.equal(ok(res).bill.discountAmount, 50);
    assert.equal(res.body.message, 'Offer applied — it replaces your promo code');

    const promo = ok(await call('POST', '/api/cart/apply-promo', f.customer, { code: 'TWENTY' }));
    assert.equal(promo.bill.discountAmount, 20);
    assert.equal((await offerNow(offer)).offerStatus, 'viewed');
  });

  test('a promo code can be taken off the cart; removing it leaves a personal offer alone', async () => {
    const f = await setup();
    await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Code', type: 'flat_amount', flatAmount: 20, code: 'TWENTY', status: 'active' });
    await add(f.customer, f.paneer, 2);
    assert.equal(ok(await call('POST', '/api/cart/apply-promo', f.customer, { code: 'TWENTY' })).bill.discountAmount, 20);
    assert.equal(ok(await call('GET', '/api/cart', f.customer)).bill.appliedCode, 'TWENTY', 'a later read still names the code');
    const removed = ok(await call('DELETE', '/api/cart/promo', f.customer));
    assert.equal(removed.bill.discountAmount, 0);
    assert.equal(removed.bill.appliedCode, null);
    assert.equal(removed.cart.appliedDiscountId ?? null, null);

    const offer = await makeOffer(f);
    ok(await applyOffer(f.customer, offer));
    const kept = ok(await call('DELETE', '/api/cart/promo', f.customer));
    assert.equal(String(kept.cart.appliedDiscountId), String(offer._id), 'DELETE /promo never drops a personal offer');
    assert.equal(kept.bill.appliedCode, null, 'a personal offer has no code to show');
  });

  test('guests can\'t apply; with the switch off every offer route is a plain 404', async () => {
    const f = await setup();
    const guest = await makeGuest();
    const offer = await makeOffer(f);
    expectError(await applyOffer(guest, offer), 401, 'GUEST_ACCOUNT_REQUIRED');

    live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
    for (const [method, path, body] of [
      ['POST', '/api/cart/apply-offer', { offerId: String(offer._id) }],
      ['DELETE', '/api/cart/offer'],
      ['GET', '/api/offers/mine'],
      ['POST', `/api/offers/${offer._id}/viewed`],
    ]) {
      expectError(await call(method, path, f.customer, body), 404, 'NOT_FOUND');
    }
    // Before authentication, too: an anonymous caller sees the same 404, not a 401.
    expectError(await call('GET', '/api/offers/mine'), 404, 'NOT_FOUND');
  });
});

// ─── Amount ────────────────────────────────────────────────────────────────

describe('amount', () => {
  const billWith = async (f, offerOverrides, lines) => {
    for (const [item, qty] of lines) await add(f.customer, item, qty);
    const offer = await makeOffer(f, offerOverrides);
    return ok(await applyOffer(f.customer, offer)).bill;
  };

  test('flat amount capped by maxDiscountAmount', async () => {
    const f = await setup();
    const bill = await billWith(f, { type: 'flat_amount', percentage: null, flatAmount: 75, maxDiscountAmount: 75 }, [[f.paneer, 1]]);
    assert.equal(bill.charges.food.discount, 7500);
  });

  test('a flat amount larger than the eligible subtotal takes only that subtotal', async () => {
    const f = await setup();
    const bill = await billWith(
      f,
      { type: 'flat_amount', percentage: null, flatAmount: 100, maxDiscountAmount: 100, applicableItems: [f.naan._id] },
      [[f.paneer, 1], [f.naan, 1]]
    );
    assert.equal(bill.charges.food.discount, 4000, 'only the ₹40 naan is eligible');
  });

  test('the bill is the pricing engine\'s own: identical to a public discount of the same amount', async () => {
    const f = await setup();
    const personal = await billWith(f, { percentage: 10, maxDiscountAmount: 100 }, [[f.paneer, 2], [f.naan, 1]]);
    // A second customer with the same cart and a public ₹54 flat code.
    const twin = await makeDeliveryCustomer();
    await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Flat', type: 'flat_amount', flatAmount: 54, code: 'FIFTYFOUR', status: 'active' });
    await add(twin, f.paneer, 2);
    await add(twin, f.naan, 1);
    const pub = ok(await call('POST', '/api/cart/apply-promo', twin, { code: 'FIFTYFOUR' })).bill;
    assert.equal(personal.charges.food.discount, 5400);
    assert.deepEqual(personal.charges, pub.charges);
  });

  test('rounding: half a paisa rounds up, exactly as a public percentage discount does', async () => {
    const f = await setup();
    const chutney = await MenuItem.create({ restaurantId: f.restaurant._id, categoryId: f.paneer.categoryId, name: 'Chutney', foodType: 'veg', sellingPrice: 2.1 });
    const personal = await billWith(f, { percentage: 5, maxDiscountAmount: 100 }, [[chutney, 1]]);
    assert.equal(personal.charges.food.discount, 11, '5% of 210 paise = 10.5 → 11');

    const twin = await makeDeliveryCustomer();
    await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Five', type: 'percentage', percentage: 5, code: 'FIVE', status: 'active' });
    await add(twin, chutney, 1);
    const pub = ok(await call('POST', '/api/cart/apply-promo', twin, { code: 'FIVE' })).bill;
    assert.equal(pub.charges.food.discount, personal.charges.food.discount);
  });
});

// ─── Re-validation, remove, clear ──────────────────────────────────────────

describe('re-validation and removal', () => {
  test('after a revoke or expiry the cart drops the discount and says why; checkout summary too', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));

    await Discount.updateOne({ _id: offer._id }, { $set: { offerStatus: 'revoked', isOpen: false, status: 'expired' } });
    const revoked = ok(await call('GET', '/api/cart', f.customer)).bill;
    assert.equal(revoked.discountAmount, 0);
    assert.equal(revoked.offerIssue, 'OFFER_EXPIRED');

    await Discount.updateOne({ _id: offer._id }, { $set: { offerStatus: 'applied', isOpen: true, status: 'active' } });
    assert.equal(ok(await call('GET', '/api/cart', f.customer)).bill.discountAmount, 50, 'valid again');
    t += 31 * MINUTE;
    const summary = ok(await call('GET', '/api/checkout/summary', f.customer));
    assert.equal(summary.bill.offerIssue, 'OFFER_EXPIRED');
    assert.equal(summary.bill.charges.food.discount, 0);
  });

  test('below the minimum after removing items → DISCOUNT_MIN_VALUE with the shortfall', async () => {
    const f = await setup();
    const offer = await makeOffer(f, { minimumOrderValue: 400 });
    const cart = await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));
    const bill = ok(await call('PATCH', `/api/cart/items/${cart.cart.items[0]._id}`, f.customer, { qty: 1 })).bill;
    assert.equal(bill.offerIssue, 'DISCOUNT_MIN_VALUE');
    assert.equal(bill.shortfallPaise, 15000);
    assert.equal(bill.discountAmount, 0);
  });

  test('a public code that stops applying adds no new fields', async () => {
    const f = await setup();
    await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Min', type: 'flat_amount', flatAmount: 20, code: 'MIN', status: 'active', minimumOrderValue: 400 });
    const cart = await add(f.customer, f.paneer, 2);
    ok(await call('POST', '/api/cart/apply-promo', f.customer, { code: 'MIN' }));
    const bill = ok(await call('PATCH', `/api/cart/items/${cart.cart.items[0]._id}`, f.customer, { qty: 1 })).bill;
    assert.equal(bill.discountAmount, 0);
    assert.ok(!('offerIssue' in bill) && !('shortfallPaise' in bill));
  });

  test('DELETE /api/cart/offer, clearing the cart, or emptying it puts the offer back to viewed', async () => {
    const f = await setup();
    const offer = await makeOffer(f);

    const added = await add(f.customer, f.paneer, 1);
    ok(await applyOffer(f.customer, offer));
    const removed = ok(await call('DELETE', '/api/cart/offer', f.customer));
    assert.equal(removed.cart.appliedDiscountId, null);
    assert.equal(removed.bill.discountAmount, 0);
    assert.equal((await offerNow(offer)).offerStatus, 'viewed');

    ok(await applyOffer(f.customer, offer));
    ok(await call('DELETE', '/api/cart', f.customer));
    assert.equal((await offerNow(offer)).offerStatus, 'viewed');

    const again = await add(f.customer, f.paneer, 1);
    ok(await applyOffer(f.customer, offer));
    ok(await call('DELETE', `/api/cart/items/${again.cart.items[0]._id}`, f.customer));
    assert.equal((await offerNow(offer)).offerStatus, 'viewed');
    assert.ok(added);
  });
});

// ─── Customer offer list + viewed ──────────────────────────────────────────

describe('GET /api/offers/mine and viewed', () => {
  test('open, unexpired offers, newest first, with the restaurant; fetching marks them delivered', async () => {
    const f = await setup();
    const other = await makeRestaurant({ name: 'Tandoor House' });
    const older = await makeOffer({ restaurant: other.restaurant, customer: f.customer }, { createdAt: new Date(t - 10 * MINUTE) });
    const newer = await makeOffer(f, { createdAt: new Date(t - MINUTE) });
    await makeOffer({ restaurant: (await makeRestaurant({ name: 'Gone' })).restaurant, customer: f.customer }, { endDate: new Date(t - 1) });
    await makeOffer({ restaurant: f.restaurant, customer: await makeDeliveryCustomer() });
    // Already on the cart: fetching must never move it back to delivered.
    const applied = await makeOffer(
      { restaurant: (await makeRestaurant({ name: 'Third' })).restaurant, customer: f.customer },
      { offerStatus: 'applied', createdAt: new Date(t - 20 * MINUTE) }
    );

    const { offers } = ok(await call('GET', '/api/offers/mine', f.customer));
    assert.deepEqual(offers.map((o) => o.id), [String(newer._id), String(older._id), String(applied._id)]);
    assert.equal((await offerNow(applied)).offerStatus, 'applied');
    assert.equal(offers[2].status, 'applied');
    assert.deepEqual(offers[1].restaurant, { id: String(other.restaurant._id), name: 'Tandoor House' });
    assert.deepEqual(Object.keys(offers[0]).sort(), [
      'applicableItemNames', 'applicableItems', 'expiresAt', 'flatAmount', 'id', 'maxDiscountAmount', 'minimumOrderValue', 'percentage', 'restaurant', 'status', 'title', 'type',
    ]);
    assert.deepEqual(offers[0].applicableItemNames, []);
    assert.ok(offers.slice(0, 2).every((o) => o.status === 'delivered'));
    const stored = await offerNow(newer);
    assert.equal(stored.offerStatus, 'delivered');
    assert.equal(stored.deliveredAt.getTime(), t);

    // Never backwards: an applied offer stays applied.
    await Discount.updateOne({ _id: newer._id }, { $set: { offerStatus: 'applied' } });
    ok(await call('GET', '/api/offers/mine', f.customer));
    assert.equal((await offerNow(newer)).offerStatus, 'applied');

    assert.deepEqual(ok(await call('GET', '/api/offers/mine', await makeGuest())).offers, []);
  });

  test('a dish-only offer names its dishes, in the list and once viewed', async () => {
    const f = await setup();
    const naanOnly = await makeOffer(f, { applicableItems: [f.naan._id] });
    const { offers } = ok(await call('GET', '/api/offers/mine', f.customer));
    assert.deepEqual(offers[0].applicableItems, [String(f.naan._id)]);
    assert.deepEqual(offers[0].applicableItemNames, [f.naan.name]);
    const viewed = ok(await call('POST', `/api/offers/${naanOnly._id}/viewed`, f.customer));
    assert.deepEqual(viewed.offer.applicableItemNames, [f.naan.name]);
  });

  test('viewed: once (one event), idempotent after; another user\'s offer → 404', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    const first = ok(await call('POST', `/api/offers/${offer._id}/viewed`, f.customer));
    assert.equal(first.offer.status, 'viewed');
    t += MINUTE;
    ok(await call('POST', `/api/offers/${offer._id}/viewed`, f.customer));

    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'viewed');
    assert.equal(stored.viewedAt.getTime(), t - MINUTE, 'not moved by the repeat');
    assert.equal(stored.deliveredAt.getTime(), t - MINUTE, 'viewed implies delivered');
    assert.equal(await ActivityEvent.countDocuments({ type: 'offer_viewed' }), 1);

    expectError(await call('POST', `/api/offers/${offer._id}/viewed`, await makeDeliveryCustomer()), 404, 'OFFER_NOT_FOUND');
    expectError(await call('POST', '/api/offers/nonsense/viewed', f.customer), 404, 'OFFER_NOT_FOUND');
  });
});

// ─── Redemption ────────────────────────────────────────────────────────────

describe('exactly-once redemption', () => {
  test('checkout redeems it: offer closed with the order id, order carries the discount, order_placed has the offer', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));
    const placed = ok(await checkout(f.customer, {}, 'redeem-1'), 201);

    const order = await Order.findById(placed.orderId).lean();
    assert.equal(String(order.appliedDiscountId), String(offer._id));
    assert.equal(order.charges.food.discount, 5000);
    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'redeemed');
    assert.equal(stored.isOpen, false);
    assert.equal(stored.status, 'expired');
    assert.equal(stored.redemptionCount, 1);
    assert.equal(String(stored.orderId), String(placed.orderId));
    const event = await ActivityEvent.findOne({ type: 'order_placed' }).lean();
    assert.equal(String(event.data.offerId), String(offer._id));

    // The same Idempotency-Key again: the same order, no second claim.
    const replay = ok(await checkout(f.customer, {}, 'redeem-1'));
    assert.equal(String(replay.order.orderId), String(placed.orderId));
    assert.equal((await offerNow(offer)).redemptionCount, 1);
    assert.equal(await Order.countDocuments(), 1);
  });

  test('10 parallel checkouts with one offer → exactly one order has it; the rest fail OFFER_ALREADY_USED, no order', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));

    // Ten devices that each still hold the full cart: every checkout reads the cart before any
    // of them carries on (a barrier on the one cart read checkout makes), so none of them finds
    // it already emptied by the winner — they can only meet on the offer itself.
    const original = Cart.findOne;
    let arrived = 0;
    let release;
    const allRead = new Promise((resolve) => {
      release = resolve;
    });
    setTimeout(() => release(), 5000).unref();
    Cart.findOne = async function barrier(...args) {
      const doc = await original.apply(this, args);
      arrived += 1;
      if (arrived === 10) release();
      await allRead;
      return doc;
    };
    let results;
    try {
      results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          srv.request('POST', '/api/orders/checkout', {
            headers: { ...authHeader(f.customer), 'Idempotency-Key': `device-${i}` },
            body: { paymentMethod: 'cod' },
          })
        )
      );
    } finally {
      Cart.findOne = original;
    }
    assert.equal(arrived, 10, 'all ten read a full cart');
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(results.map((r) => r.body.code ?? r.status)));
    for (const r of results.filter((x) => x.status !== 201)) {
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'OFFER_ALREADY_USED');
    }
    assert.equal(await Order.countDocuments(), 1);
    const [order] = await Order.find().lean();
    assert.equal(String(order.appliedDiscountId), String(offer._id));
    assert.equal((await offerNow(offer)).redemptionCount, 1);
  });

  test('an expectedTotalPaise mismatch fails before any claim', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));
    expectError(await checkout(f.customer, { expectedTotalPaise: 1 }), 409, 'PRICE_CHANGED');
    const stored = await offerNow(offer);
    assert.equal(stored.redemptionCount, 0);
    assert.equal(stored.offerStatus, 'applied');
  });

  test('order creation failing after the claim gives the claim back; the offer is still usable', async () => {
    const f = await setup();
    const offer = await makeOffer(f);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));

    const original = Order.create;
    Order.create = async () => {
      throw new Error('simulated database failure');
    };
    try {
      assert.equal((await checkout(f.customer)).status, 500);
    } finally {
      Order.create = original;
    }
    const stored = await offerNow(offer);
    assert.equal(stored.redemptionCount, 0);
    assert.equal(stored.isOpen, true);

    ok(await checkout(f.customer), 201);
    assert.equal((await offerNow(offer)).offerStatus, 'redeemed');
  });
});

// ─── Cancellation ──────────────────────────────────────────────────────────

describe('release on cancellation', () => {
  /** Places a COD order that redeems a fresh offer. */
  const placeWithOffer = async (f, offerOverrides = {}, body = {}) => {
    const offer = await makeOffer(f, offerOverrides);
    await add(f.customer, f.paneer, 2);
    ok(await applyOffer(f.customer, offer));
    const placed = ok(await checkout(f.customer, body), 201);
    return { offer, orderId: placed.orderId };
  };
  const expectReopened = async (offer) => {
    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'viewed');
    assert.equal(stored.isOpen, true);
    assert.equal(stored.status, 'active');
    assert.equal(stored.redemptionCount, 0);
    assert.equal(stored.orderId, null);
    assert.equal(stored.redeemedAt, null);
  };

  test('customer cancels at placed → reopened as viewed, not put back on any cart', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    ok(await call('POST', `/api/orders/${orderId}/cancel`, f.customer, {}));
    await expectReopened(offer);
    assert.equal((await Cart.findOne({ userId: f.customer._id }).lean()).appliedDiscountId, null);
  });

  test('restaurant rejects → reopened', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    ok(await call('PATCH', `/api/owner/${f.restaurant._id}/orders/${orderId}/reject`, f.owner, { reason: 'Kitchen closed' }));
    await expectReopened(offer);
  });

  test('approval timeout → reopened', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    await expireUnansweredOrders({ now: new Date(Date.now() + (env.ORDER_APPROVAL_TIMEOUT_MINUTES + 1) * MINUTE) });
    assert.equal((await Order.findById(orderId).lean()).status, 'cancelled');
    await expectReopened(offer);
  });

  test('unpaid online order expires → reopened', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f, {}, { paymentMethod: 'online' });
    assert.equal((await Order.findById(orderId).lean()).paymentStatus, 'pending');
    await expireUnansweredOrders({ now: new Date(Date.now() + (env.ORDER_APPROVAL_TIMEOUT_MINUTES + 1) * MINUTE) });
    const order = await Order.findById(orderId).lean();
    assert.equal(order.status, 'cancelled');
    assert.equal(order.cancellationReason, 'Payment was not completed');
    await expectReopened(offer);
  });

  test('cancelled after the restaurant accepted → stays redeemed', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    ok(await call('PATCH', `/api/owner/${f.restaurant._id}/orders/${orderId}/accept`, f.owner));
    ok(await call('POST', `/api/orders/${orderId}/cancel`, f.customer, {}));
    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'redeemed');
    assert.equal(stored.redemptionCount, 1);
    assert.equal(String(stored.orderId), String(orderId));
  });

  test('a second cancel event is a no-op: decremented once', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    ok(await call('POST', `/api/orders/${orderId}/cancel`, f.customer, {}));
    const order = await Order.findById(orderId).lean();
    assert.equal(await releaseOfferForCancelledOrder(order), null);
    assert.equal(await releaseOfferForCancelledOrder(order), null);
    assert.equal((await offerNow(offer)).redemptionCount, 0);
  });

  test('past its expiry by the time of the cancel → expired', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    t += 31 * MINUTE;
    ok(await call('POST', `/api/orders/${orderId}/cancel`, f.customer, {}));
    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'expired');
    assert.equal(stored.isOpen, false);
    assert.equal(stored.redemptionCount, 0);
  });

  test('a newer open offer exists → the old one becomes expired, no E11000 escapes', async () => {
    const f = await setup();
    const { offer, orderId } = await placeWithOffer(f);
    const newer = await makeOffer(f, { offerName: 'Newer' });
    ok(await call('POST', `/api/orders/${orderId}/cancel`, f.customer, {}));
    const stored = await offerNow(offer);
    assert.equal(stored.offerStatus, 'expired');
    assert.equal(stored.isOpen, false);
    assert.equal((await offerNow(newer)).isOpen, true);
  });
});

// ─── Settlement ────────────────────────────────────────────────────────────

test('settlement: a personal-offer order settles on the discounted food base, exactly like a public discount', async () => {
  const f = await setup();
  const offer = await makeOffer(f, { type: 'flat_amount', percentage: null, flatAmount: 50, maxDiscountAmount: 50 });
  await add(f.customer, f.paneer, 2);
  ok(await applyOffer(f.customer, offer));
  const personalOrder = await Order.findById(ok(await checkout(f.customer), 201).orderId).lean();

  const twin = await makeDeliveryCustomer();
  await Discount.create({ restaurantId: f.restaurant._id, offerName: 'Fifty', type: 'flat_amount', flatAmount: 50, code: 'FIFTY', status: 'active' });
  await add(twin, f.paneer, 2);
  ok(await call('POST', '/api/cart/apply-promo', twin, { code: 'FIFTY' }));
  const publicOrder = await Order.findById(ok(await checkout(twin), 201).orderId).lean();

  assert.equal(personalOrder.charges.food.subtotal, 50000);
  assert.equal(personalOrder.charges.food.discount, 5000);
  assert.equal(personalOrder.charges.food.base, 45000, 'food base after the discount');
  assert.deepEqual(personalOrder.charges, publicOrder.charges);

  const settings = await getActiveSettings();
  const line = (order) => computeRestaurantSettlementLine({ charges: order.charges, paymentChannel: 'online', settings });
  assert.deepEqual(line(personalOrder), line(publicOrder));
});
