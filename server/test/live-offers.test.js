// Live customer activity — A4: personal offers (model, creation API with every guardrail, revoke,
// expiry), the owner's live dashboard reads (sessions with bulk eligibility, session detail,
// events paging, offer history, metrics), personal offers hidden from every public / promo
// surface, the Discount code index fix and the Live Monitor mass-assignment fix.
// In-memory MongoDB, the real HTTP API and a fake clock.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const offers = await import('../services/personalOffer.service.js');
const { liveOfferLimiter, liveOfferLimiterKey } = await import('../middleware/rateLimiter.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: Order } = await import('../models/Order.js');
const {
  ObjectId,
  authHeader,
  makeCustomer,
  makeGuest,
  makeRestaurant,
  makeSession,
  RESTAURANT_AT,
} = await import('../test-utils/liveFixtures.mjs');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// 15:30 IST on 27 Oct 2026.
const T0 = Date.parse('2026-10-27T10:00:00Z');

let mongo;
let srv;
let t;

const call = (method, path, user, body) => srv.request(method, path, { headers: user ? authHeader(user) : {}, body });

/** POST /offers with the per-restaurant budget reset first (only the rate-limit test spends it). */
const send = async (owner, restaurant, body) => {
  await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));
  return call('POST', `/api/owner/${restaurant._id}/live/offers`, owner, body);
};

const offerBody = (session, overrides = {}) => ({
  sessionId: String(session._id),
  title: 'Come back treat',
  type: 'percentage',
  percentage: 10,
  maxDiscountAmount: 100,
  expiresInMinutes: 30,
  ...overrides,
});

const expectError = (res, status, code) => {
  assert.equal(res.status, status, `${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, code);
};

/** A restaurant (owner + dishes) and a signed-in customer with an open session there. */
const setup = async ({ customer: customerOverrides, session: sessionOverrides } = {}) => {
  const fixtures = await makeRestaurant();
  const customer = await makeCustomer(customerOverrides);
  const session = await makeSession({
    restaurantId: fixtures.restaurant._id,
    userId: customer._id,
    lastActivityAt: new Date(t),
    ...sessionOverrides,
  });
  return { ...fixtures, customer, session };
};

/** A closed personal offer created at `at` (for daily-limit and metrics seeding). */
const seedOffer = (restaurant, customer, at, overrides = {}) =>
  Discount.create({
    restaurantId: restaurant._id,
    offerName: 'Seeded',
    type: 'percentage',
    percentage: 10,
    maxDiscountAmount: 100,
    kind: 'personal',
    targetUserId: customer._id,
    offerStatus: 'revoked',
    isOpen: false,
    status: 'expired',
    applicableTo: 'delivery',
    startDate: at,
    endDate: new Date(at.getTime() + 30 * MINUTE),
    createdAt: at,
    ...overrides,
  });

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CustomerSession.init(), ActivityEvent.init(), Discount.init()]);
  srv = await startTestServer({ withSocket: true });
});

after(async () => {
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  t = T0;
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
});

// ─── Access ────────────────────────────────────────────────────────────────

describe('access', () => {
  test('another owner\'s restaurant → 403 NOT_OWNER on every live route (same as every owner route)', async () => {
    const b = await setup();
    const a = await makeRestaurant({ name: 'Other Place' });
    const offer = await seedOffer(b.restaurant, b.customer, new Date(t), { isOpen: true, offerStatus: 'sent', status: 'active' });
    const base = `/api/owner/${b.restaurant._id}/live`;
    const routes = [
      ['GET', `${base}/sessions`],
      ['GET', `${base}/sessions/${b.session._id}`],
      ['GET', `${base}/sessions/${b.session._id}/events`],
      ['POST', `${base}/offers`, offerBody(b.session)],
      ['POST', `${base}/offers/${offer._id}/revoke`],
      ['GET', `${base}/offers`],
      ['GET', `${base}/metrics`],
    ];
    for (const [method, path, body] of routes) {
      expectError(await call(method, path, a.owner, body), 403, 'NOT_OWNER');
    }
    assert.equal(await Discount.countDocuments(), 1, 'nothing sent');
    assert.equal((await Discount.findById(offer._id)).offerStatus, 'sent', 'not revoked');
  });

  test('another restaurant\'s session or offer, an unknown id, or a hidden session → 404 under my own restaurant', async () => {
    const mine = await setup();
    const theirs = await setup();
    const hiddenCustomer = await makeCustomer();
    const hidden = await makeSession({ restaurantId: mine.restaurant._id, userId: hiddenCustomer._id, hiddenAt: new Date(t), status: 'ended' });
    const theirOffer = await seedOffer(theirs.restaurant, theirs.customer, new Date(t), { isOpen: true, offerStatus: 'sent', status: 'active' });
    const base = `/api/owner/${mine.restaurant._id}/live`;

    for (const id of [theirs.session._id, new ObjectId(), hidden._id, 'not-an-id']) {
      expectError(await call('GET', `${base}/sessions/${id}`, mine.owner), 404, 'SESSION_NOT_FOUND');
      expectError(await call('GET', `${base}/sessions/${id}/events`, mine.owner), 404, 'SESSION_NOT_FOUND');
    }
    for (const id of [theirs.session._id, new ObjectId(), hidden._id]) {
      expectError(await send(mine.owner, mine.restaurant, offerBody({ _id: id })), 404, 'SESSION_NOT_FOUND');
    }
    expectError(await call('POST', `${base}/offers/${theirOffer._id}/revoke`, mine.owner), 404, 'OFFER_NOT_FOUND');
    expectError(await call('POST', `${base}/offers/${new ObjectId()}/revoke`, mine.owner), 404, 'OFFER_NOT_FOUND');

    const list = (await call('GET', `${base}/sessions`, mine.owner)).body.data.sessions;
    assert.deepEqual(list.map((s) => s.id), [String(mine.session._id)], 'only my visible session');
    const theirOffers = (await call('GET', `${base}/offers`, mine.owner)).body.data.offers;
    assert.deepEqual(theirOffers, []);
  });

  test('switch off or restaurant outside the pilot → every live route is the app\'s ordinary 404', async () => {
    const { owner, restaurant, session } = await setup();
    const base = `/api/owner/${restaurant._id}/live`;
    const unknown = await call('GET', `/api/owner/${restaurant._id}/no-such-route`, owner);
    const routes = [
      ['GET', `${base}/sessions`],
      ['GET', `${base}/sessions/${session._id}`],
      ['GET', `${base}/sessions/${session._id}/events`],
      ['POST', `${base}/offers`, offerBody(session)],
      ['POST', `${base}/offers/${new ObjectId()}/revoke`],
      ['GET', `${base}/offers`],
      ['GET', `${base}/metrics`],
    ];
    for (const settings of [{ enabled: false, restaurantIds: '' }, { enabled: true, restaurantIds: String(new ObjectId()) }]) {
      live.__setLiveActivityForTests(settings);
      for (const [method, path, body] of routes) {
        const res = await call(method, path, owner, body);
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.deepEqual({ ...res.body, message: undefined }, { ...unknown.body, message: undefined });
      }
    }
    assert.equal(await Discount.countDocuments(), 0);
  });
});

// ─── Sending ───────────────────────────────────────────────────────────────

describe('sending an offer', () => {
  test('201: server-set fields, offer_sent on the timeline, id on the session', async () => {
    const { owner, restaurant, customer, session, paneer } = await setup();
    const res = await send(owner, restaurant, offerBody(session, { applicableItems: [String(paneer._id)], minimumOrderValue: 200 }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const view = res.body.data.offer;
    assert.equal(view.status, 'sent');
    assert.equal(view.title, 'Come back treat');
    assert.equal(view.expiresAt, new Date(T0 + 30 * MINUTE).toISOString());

    const stored = await Discount.findById(view.id).lean();
    assert.equal(stored.kind, 'personal');
    assert.equal(String(stored.restaurantId), String(restaurant._id));
    assert.equal(String(stored.targetUserId), String(customer._id));
    assert.equal(String(stored.sessionId), String(session._id));
    assert.equal(String(stored.createdBy), String(owner._id));
    assert.equal(stored.offerName, 'Come back treat');
    assert.equal(stored.applicableTo, 'delivery');
    assert.equal(stored.status, 'active');
    assert.equal(stored.isOpen, true);
    assert.equal(stored.maxRedemptions, 1);
    assert.equal(stored.redemptionCount, 0);
    assert.equal(stored.code, null);
    assert.equal(stored.createdAt.getTime(), T0);

    const after = await CustomerSession.findById(session._id).lean();
    assert.deepEqual(after.offerIds.map(String), [view.id]);
    assert.equal(after.lastEvent.type, 'offer_sent');
    assert.equal(after.lastEvent.label, 'Offer sent: 10% off up to ₹100');
    assert.equal(after.lastActivityAt.getTime(), session.lastActivityAt.getTime(), 'not customer activity');
    const [event] = await ActivityEvent.find({ sessionId: session._id }).lean();
    assert.equal(event.type, 'offer_sent');
    assert.equal(String(event.data.offerId), view.id);
  });

  test('every guardrail rejects with its own code, and nothing is saved', async () => {
    const { owner, restaurant, session } = await setup();
    const foreign = await makeRestaurant({ name: 'Elsewhere' });
    const cases = [
      [{ percentage: 51 }, 400, 'OFFER_TOO_LARGE'],
      [{ percentage: 0 }, 400, 'OFFER_TOO_LARGE'],
      [{ percentage: undefined }, 400, 'OFFER_TOO_LARGE'],
      [{ type: 'flat_amount', percentage: undefined, flatAmount: 501, maxDiscountAmount: 500 }, 400, 'OFFER_TOO_LARGE'],
      [{ type: 'flat_amount', percentage: undefined, flatAmount: 0, maxDiscountAmount: 100 }, 400, 'OFFER_TOO_LARGE'],
      [{ type: 'flat_amount', percentage: undefined, flatAmount: 100, maxDiscountAmount: 50 }, 400, 'OFFER_TOO_LARGE'],
      [{ maxDiscountAmount: 501 }, 400, 'OFFER_TOO_LARGE'],
      [{ maxDiscountAmount: 0 }, 400, 'OFFER_TOO_LARGE'],
      [{ maxDiscountAmount: undefined }, 400, 'OFFER_TOO_LARGE'],
      [{ expiresInMinutes: 9 }, 400, 'INVALID_EXPIRY'],
      [{ expiresInMinutes: 25 * 60 }, 400, 'INVALID_EXPIRY'],
      [{ applicableItems: [String(foreign.paneer._id)] }, 400, 'ITEM_NOT_IN_MENU'],
      [{ applicableItems: [String(new ObjectId())] }, 400, 'ITEM_NOT_IN_MENU'],
      [{ percentage: 10.5 }, 400, 'VALIDATION_ERROR'],
      [{ maxDiscountAmount: 99.5 }, 400, 'VALIDATION_ERROR'],
      [{ expiresInMinutes: 30.5 }, 400, 'VALIDATION_ERROR'],
      [{ type: 'flat_amount', percentage: undefined, flatAmount: 49.99, maxDiscountAmount: 100 }, 400, 'VALIDATION_ERROR'],
      [{ title: '   ' }, 400, 'VALIDATION_ERROR'],
      [{ title: 'x'.repeat(41) }, 400, 'VALIDATION_ERROR'],
      [{ applicableItems: Array.from({ length: 21 }, () => String(new ObjectId())) }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [overrides, status, code] of cases) {
      expectError(await send(owner, restaurant, offerBody(session, overrides)), status, code);
    }
    assert.equal(await Discount.countDocuments(), 0);
    assert.equal(await ActivityEvent.countDocuments(), 0);
  });

  test('guest, opted-out and closed sessions are refused — in that order', async () => {
    const { owner, restaurant } = await setup();
    const guest = await makeGuest();
    const guestSession = await makeSession({ restaurantId: restaurant._id, userId: guest._id, isGuest: true, displayName: 'Guest', status: 'ended' });
    const optedOut = await makeCustomer({ preferences: { shareActivity: false } });
    const optedOutSession = await makeSession({ restaurantId: restaurant._id, userId: optedOut._id, status: 'ended' });
    const closedCustomer = await makeCustomer();
    const closed = await makeSession({ restaurantId: restaurant._id, userId: closedCustomer._id, status: 'abandoned' });

    // A bad value as well, to prove the session checks come first.
    const bad = { percentage: 99 };
    expectError(await send(owner, restaurant, offerBody(guestSession, bad)), 409, 'GUEST_NOT_ELIGIBLE');
    expectError(await send(owner, restaurant, offerBody(optedOutSession, bad)), 409, 'OPTED_OUT');
    expectError(await send(owner, restaurant, offerBody(closed, bad)), 409, 'SESSION_CLOSED');
    expectError(await send(owner, restaurant, offerBody(closed)), 409, 'SESSION_CLOSED');
    assert.equal(await Discount.countDocuments(), 0);
  });

  test('a second open offer → OFFER_ALREADY_ACTIVE; two concurrent POSTs → one 201, one 409', async () => {
    const { owner, restaurant, session, customer } = await setup();
    assert.equal((await send(owner, restaurant, offerBody(session))).status, 201);
    expectError(await send(owner, restaurant, offerBody(session)), 409, 'OFFER_ALREADY_ACTIVE');

    await Discount.updateMany({}, { $set: { isOpen: false, offerStatus: 'revoked', status: 'expired' } });
    await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));
    const results = await Promise.all([1, 2].map(() => call('POST', `/api/owner/${restaurant._id}/live/offers`, owner, offerBody(session))));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409).body.code, 'OFFER_ALREADY_ACTIVE');
    assert.equal(await Discount.countDocuments({ targetUserId: customer._id, isOpen: true }), 1);
  });

  test('a 4th offer in one IST day is refused even after revoking the first three', async () => {
    const { owner, restaurant, session } = await setup();
    for (let i = 0; i < 3; i += 1) {
      const res = await send(owner, restaurant, offerBody(session));
      assert.equal(res.status, 201);
      t += MINUTE;
      const revoked = await call('POST', `/api/owner/${restaurant._id}/live/offers/${res.body.data.offer.id}/revoke`, owner);
      assert.equal(revoked.status, 200);
    }
    expectError(await send(owner, restaurant, offerBody(session)), 409, 'DAILY_OFFER_LIMIT');
  });

  test('with 2 offers created and closed today, 4 concurrent POSTs → exactly one 201, never more than 3 a day', async () => {
    const { owner, restaurant, session, customer } = await setup();
    await seedOffer(restaurant, customer, new Date(T0 - 2 * 60 * MINUTE));
    await seedOffer(restaurant, customer, new Date(T0 - 60 * MINUTE));
    await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => call('POST', `/api/owner/${restaurant._id}/live/offers`, owner, offerBody(session)))
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses));
    for (const r of results.filter((x) => x.status !== 201)) {
      assert.ok(['OFFER_ALREADY_ACTIVE', 'DAILY_OFFER_LIMIT'].includes(r.body.code), r.body.code);
    }
    assert.equal(await Discount.countDocuments({ targetUserId: customer._id }), 3);
  });

  test('IST day boundary: offers at 23:59 IST and 00:01 IST count on different days', async () => {
    const { owner, restaurant, session, customer } = await setup();
    const istMidnight = Date.parse('2026-10-27T18:30:00Z'); // 28 Oct 00:00 IST
    await seedOffer(restaurant, customer, new Date(istMidnight - 30 * MINUTE));
    await seedOffer(restaurant, customer, new Date(istMidnight - 20 * MINUTE));

    t = istMidnight - MINUTE; // 23:59 IST: the third of the day
    const late = await send(owner, restaurant, offerBody(session));
    assert.equal(late.status, 201);
    await call('POST', `/api/owner/${restaurant._id}/live/offers/${late.body.data.offer.id}/revoke`, owner);
    expectError(await send(owner, restaurant, offerBody(session)), 409, 'DAILY_OFFER_LIMIT');

    t = istMidnight + MINUTE; // 00:01 IST: a new day
    assert.equal((await send(owner, restaurant, offerBody(session))).status, 201);
  });

  test('the body can\'t set server fields: .strict() rejects them with 400 and nothing is saved', async () => {
    const { owner, restaurant, session } = await setup();
    const other = await makeRestaurant({ name: 'Other' });
    for (const extra of [
      { restaurantId: String(other.restaurant._id) },
      { targetUserId: String(new ObjectId()) },
      { redemptionCount: 5 },
      { offerStatus: 'redeemed' },
      { kind: 'public' },
      { isOpen: false },
      { code: 'FREE' },
    ]) {
      expectError(await send(owner, restaurant, { ...offerBody(session), ...extra }), 400, 'VALIDATION_ERROR');
    }
    assert.equal(await Discount.countDocuments(), 0);
  });

  test('20 offers a minute per restaurant; the 21st → 429 RATE_LIMITED; previews are not counted', async () => {
    const { owner, restaurant, session } = await setup();
    await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));
    const path = `/api/owner/${restaurant._id}/live/offers`;
    for (let i = 0; i < 25; i += 1) {
      assert.equal((await call('POST', path, owner, offerBody(session, { preview: true }))).status, 200);
    }
    for (let i = 0; i < 20; i += 1) {
      assert.notEqual((await call('POST', path, owner, offerBody(session, { percentage: 99 }))).status, 429, `request ${i + 1}`);
    }
    expectError(await call('POST', path, owner, offerBody(session)), 429, 'RATE_LIMITED');
    await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));
  });
});

// ─── Preview ───────────────────────────────────────────────────────────────

describe('preview', () => {
  test('prices against the current server cart, saves nothing, counts toward nothing', async () => {
    const { owner, restaurant, session, customer, paneer, naan } = await setup();
    await Cart.create({
      userId: customer._id,
      restaurantId: restaurant._id,
      items: [
        { menuItemId: paneer._id, name: 'Paneer Tikka', unitPrice: 250, qty: 2 },
        { menuItemId: naan._id, name: 'Butter Naan', unitPrice: 40, qty: 1 },
      ],
    });

    // 10% of the paneer lines (₹500) is ₹50, capped at ₹30.
    const capped = await send(owner, restaurant, offerBody(session, { applicableItems: [String(paneer._id)], maxDiscountAmount: 30, preview: true }));
    assert.equal(capped.status, 200, JSON.stringify(capped.body));
    assert.deepEqual(capped.body.data, { wouldSavePaise: 3000, cartTotalPaise: 54000, eligibleSubtotalPaise: 50000 });

    // 10% of everything (₹540) is ₹54, under the ₹100 cap.
    const whole = await send(owner, restaurant, offerBody(session, { preview: true }));
    assert.equal(whole.body.data.wouldSavePaise, 5400);

    const flat = await send(owner, restaurant, offerBody(session, { type: 'flat_amount', percentage: undefined, flatAmount: 75, maxDiscountAmount: 75, preview: true }));
    assert.equal(flat.body.data.wouldSavePaise, 7500);

    const minimum = await send(owner, restaurant, offerBody(session, { minimumOrderValue: 600, preview: true }));
    assert.deepEqual(minimum.body.data, { wouldSavePaise: 0, cartTotalPaise: 54000, eligibleSubtotalPaise: 54000, issue: 'DISCOUNT_MIN_VALUE' });

    // A preview still runs every check.
    expectError(await send(owner, restaurant, offerBody(session, { percentage: 60, preview: true })), 400, 'OFFER_TOO_LARGE');

    assert.equal(await Discount.countDocuments(), 0);
    assert.equal(await ActivityEvent.countDocuments(), 0);
    assert.deepEqual((await CustomerSession.findById(session._id).lean()).offerIds, []);

    // Four previews later, three real offers still fit in the day.
    for (let i = 0; i < 3; i += 1) {
      const res = await send(owner, restaurant, offerBody(session));
      assert.equal(res.status, 201);
      await Discount.updateOne({ _id: res.body.data.offer.id }, { $set: { isOpen: false, offerStatus: 'revoked', status: 'expired' } });
    }
  });

  test('no cart (or a cart from another restaurant) → NO_CART', async () => {
    const { owner, restaurant, session, customer } = await setup();
    const res = await send(owner, restaurant, offerBody(session, { preview: true }));
    assert.deepEqual(res.body.data, { wouldSavePaise: 0, cartTotalPaise: 0, eligibleSubtotalPaise: 0, issue: 'NO_CART' });

    const other = await makeRestaurant({ name: 'Other' });
    await Cart.create({ userId: customer._id, restaurantId: other.restaurant._id, items: [{ menuItemId: other.paneer._id, name: 'P', unitPrice: 250, qty: 1 }] });
    const elsewhere = await send(owner, restaurant, offerBody(session, { preview: true }));
    assert.equal(elsewhere.body.data.issue, 'NO_CART');
  });
});

// ─── Hidden from public surfaces ───────────────────────────────────────────

describe('personal offers stay private', () => {
  test('never in the home banner, search hasOffers, the owner discount list, or apply-promo', async () => {
    const { owner, restaurant, customer, paneer } = await setup();
    const now = new Date(t);
    // Deliberately "featured", "active" and given a code — only `kind` keeps it hidden.
    const personal = await Discount.create({
      restaurantId: restaurant._id,
      offerName: 'Just for you',
      type: 'percentage',
      percentage: 10,
      maxDiscountAmount: 100,
      code: 'SECRET',
      kind: 'personal',
      targetUserId: customer._id,
      offerStatus: 'sent',
      isOpen: true,
      status: 'active',
      isFeatured: true,
      startDate: new Date(now.getTime() - MINUTE),
      endDate: new Date(now.getTime() + DAY),
    });
    const [lng, lat] = RESTAURANT_AT;

    const feed = await call('GET', `/api/home/feed?lat=${lat}&lng=${lng}`, customer);
    assert.equal(feed.status, 200, JSON.stringify(feed.body));
    assert.equal(feed.body.data.banner, null);

    const search = await call('GET', `/api/restaurants?q=Spice&hasOffers=true`, customer);
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.data.restaurants, []);

    const list = await call('GET', `/api/owner/${restaurant._id}/discounts`, owner);
    assert.deepEqual(list.body.data.discounts, []);
    expectError(await call('PATCH', `/api/owner/${restaurant._id}/discounts/${personal._id}/draft`, owner), 404, 'NOT_FOUND');
    expectError(await call('PATCH', `/api/owner/${restaurant._id}/discounts/${personal._id}/publish`, owner), 404, 'NOT_FOUND');
    expectError(
      await call('PATCH', `/api/owner/${restaurant._id}/discounts/${personal._id}`, owner, {
        offerName: 'Edited',
        type: 'percentage',
        percentage: 50,
        startDate: now.toISOString(),
        endDate: new Date(now.getTime() + DAY).toISOString(),
      }),
      404,
      'NOT_FOUND'
    );
    expectError(await call('DELETE', `/api/owner/${restaurant._id}/discounts/${personal._id}`, owner), 404, 'NOT_FOUND');
    assert.equal((await Discount.findById(personal._id).lean()).offerName, 'Just for you', 'untouched');

    await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 });
    expectError(await call('POST', '/api/cart/apply-promo', customer, { code: 'SECRET' }), 404, 'NOT_FOUND');

    // A public offer at the same restaurant still shows everywhere.
    // The home feed and search read the real clock, not this suite's fixed one — so the window
    // covers both (a window built from the fixed clock alone expired a day after T0).
    const realNow = Date.now();
    await Discount.create({
      restaurantId: restaurant._id,
      offerName: 'Public',
      type: 'percentage',
      percentage: 5,
      status: 'active',
      isFeatured: true,
      startDate: new Date(Math.min(now.getTime(), realNow) - MINUTE),
      endDate: new Date(Math.max(now.getTime(), realNow) + DAY),
    });
    assert.equal((await call('GET', `/api/home/feed?lat=${lat}&lng=${lng}`, customer)).body.data.banner.offerName, 'Public');
    assert.equal((await call('GET', `/api/restaurants?q=Spice&hasOffers=true`, customer)).body.data.restaurants.length, 1);
    assert.equal((await call('GET', `/api/owner/${restaurant._id}/discounts`, owner)).body.data.discounts.length, 1);
  });

  test('code index: two code-less offers at one restaurant are fine; a repeated code is still refused', async () => {
    const restaurantId = new ObjectId();
    const base = { restaurantId, type: 'percentage', percentage: 10, status: 'active' };
    await Discount.create({ ...base, offerName: 'Automatic 1' });
    await Discount.create({ ...base, offerName: 'Automatic 2' });
    await Discount.create({ ...base, offerName: 'Coupon', code: 'SAVE10' });
    await assert.rejects(Discount.create({ ...base, offerName: 'Copy', code: 'SAVE10' }), (err) => err.code === 11000);
    await Discount.create({ ...base, restaurantId: new ObjectId(), offerName: 'Same code elsewhere', code: 'SAVE10' });
    const names = (await Discount.collection.indexes()).map((i) => i.name);
    assert.ok(names.includes('code_restaurantId_string_unique'));
    assert.ok(!names.includes('code_1_restaurantId_1'), 'the old sparse index is not declared any more');
  });
});

// ─── Revoke + expiry ───────────────────────────────────────────────────────

describe('revoke and expiry', () => {
  test('revoke works once; a redeemed or in-flight offer → OFFER_NOT_REVOCABLE', async () => {
    const { owner, restaurant, session, customer } = await setup();
    const sent = await send(owner, restaurant, offerBody(session));
    const id = sent.body.data.offer.id;
    const path = (offerId) => `/api/owner/${restaurant._id}/live/offers/${offerId}/revoke`;

    t += 5 * MINUTE;
    const res = await call('POST', path(id), owner);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.offer.status, 'revoked');
    const stored = await Discount.findById(id).lean();
    assert.equal(stored.isOpen, false);
    assert.equal(stored.status, 'expired');
    assert.equal(stored.revokedAt.getTime(), t);
    expectError(await call('POST', path(id), owner), 409, 'OFFER_NOT_REVOCABLE');

    const redeemed = await seedOffer(restaurant, customer, new Date(t), { offerStatus: 'redeemed', redemptionCount: 1, redeemedAt: new Date(t) });
    expectError(await call('POST', path(redeemed._id), owner), 409, 'OFFER_NOT_REVOCABLE');

    const inFlight = await seedOffer(restaurant, customer, new Date(t), { offerStatus: 'applied', isOpen: true, status: 'active', redemptionCount: 1 });
    expectError(await call('POST', path(inFlight._id), owner), 409, 'OFFER_NOT_REVOCABLE');
    assert.equal((await Discount.findById(inFlight._id).lean()).isOpen, true);
  });

  test('the sweep expires a lapsed offer and leaves one with a redemption in flight alone', async () => {
    const { restaurant, customer } = await setup();
    const other = await makeCustomer();
    const start = new Date(t);
    const lapsed = await seedOffer(restaurant, customer, start, { offerStatus: 'sent', isOpen: true, status: 'active' });
    const claimed = await seedOffer(restaurant, other, start, { offerStatus: 'applied', isOpen: true, status: 'active', redemptionCount: 1 });
    const fresh = await seedOffer(restaurant, await makeCustomer(), start, { offerStatus: 'sent', isOpen: true, status: 'active', endDate: new Date(t + 2 * 60 * MINUTE) });

    t += 31 * MINUTE;
    const summary = await activity.sweepSessions(clock.now());
    assert.equal(summary.expired, 1);
    const after = await Discount.findById(lapsed._id).lean();
    assert.equal(after.offerStatus, 'expired');
    assert.equal(after.isOpen, false);
    assert.equal(after.status, 'expired');
    assert.equal((await Discount.findById(claimed._id).lean()).isOpen, true);
    assert.equal((await Discount.findById(fresh._id).lean()).isOpen, true);
  });
});

// ─── Dashboard reads ───────────────────────────────────────────────────────

describe('dashboard reads', () => {
  test('session list: eligibility reason for each case, newest first, statuses filtered', async () => {
    const { owner, restaurant, session: ok, customer } = await setup();
    const rid = restaurant._id;
    const make = async (sessionOverrides, customerOverrides) => {
      const user = customerOverrides === 'guest' ? await makeGuest() : await makeCustomer(customerOverrides);
      return makeSession({ restaurantId: rid, userId: user._id, isGuest: customerOverrides === 'guest', ...sessionOverrides, lastActivityAt: new Date(t - (sessionOverrides.ago ?? 0)) });
    };
    const guest = await make({ ago: 1000 }, 'guest');
    const optedOut = await make({ ago: 2000 }, { preferences: { shareActivity: false } });
    const withOffer = await make({ ago: 3000 });
    await seedOffer(restaurant, { _id: withOffer.userId }, new Date(t), { isOpen: true, offerStatus: 'sent', status: 'active' });
    const limited = await make({ ago: 4000 });
    for (let i = 0; i < 3; i += 1) await seedOffer(restaurant, { _id: limited.userId }, new Date(t - i * MINUTE));
    const abandoned = await make({ ago: 5000, status: 'abandoned', lastEvent: { type: 'cart_abandoned', label: 'x', at: new Date(t - 10 * MINUTE) }, cart: { items: [{ menuItemId: new ObjectId(), name: 'P', qty: 1, unitPricePaise: 100 }], totalPaise: 100 } });
    await make({ ago: 6000, status: 'ended' });
    await make({ ago: 7000, status: 'converted' });

    const res = await call('GET', `/api/owner/${rid}/live/sessions`, owner);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.data.sessions;
    assert.deepEqual(rows.map((r) => r.id), [ok, guest, optedOut, withOffer, limited, abandoned].map((s) => String(s._id)));
    assert.deepEqual(
      rows.map((r) => [r.offerEligible, r.notEligibleReason]),
      [[true, null], [false, 'GUEST'], [false, 'OPTED_OUT'], [false, 'OFFER_OPEN'], [false, 'DAILY_LIMIT'], [false, 'SESSION_CLOSED']]
    );
    assert.ok(!JSON.stringify(rows).includes(String(customer._id)), 'no user ids in rows');
    assert.deepEqual(res.body.data.summary, { live: 5, cartsInProgress: 0, cartsTotalPaise: 0, abandonedLastHour: 1 });

    const onlyIdle = await call('GET', `/api/owner/${rid}/live/sessions?status=idle`, owner);
    assert.deepEqual(onlyIdle.body.data.sessions, []);
    for (const bad of ['ended', 'converted', 'active,nope', '']) {
      const r = await call('GET', `/api/owner/${rid}/live/sessions?status=${bad}`, owner);
      if (bad === '') assert.equal(r.status, 200, 'empty = default');
      else expectError(r, 400, 'VALIDATION_ERROR');
    }
    expectError(await call('GET', `/api/owner/${rid}/live/sessions?limit=51`, owner), 400, 'VALIDATION_ERROR');
    assert.equal((await call('GET', `/api/owner/${rid}/live/sessions?limit=2`, owner)).body.data.sessions.length, 2);
  });

  test('summary: live sessions, carts in progress with their total, abandoned in the last hour', async () => {
    const { owner, restaurant } = await setup();
    const cart = (paise) => ({ items: [{ menuItemId: new ObjectId(), name: 'P', qty: 1, unitPricePaise: paise }], totalPaise: paise });
    const rid = restaurant._id;
    await makeSession({ restaurantId: rid, lastActivityAt: new Date(t), cart: cart(30000) });
    await makeSession({ restaurantId: rid, lastActivityAt: new Date(t), status: 'idle', cart: cart(12000) });
    await makeSession({ restaurantId: rid, status: 'abandoned', lastEvent: { type: 'cart_abandoned', label: 'x', at: new Date(t - 2 * 60 * MINUTE) }, cart: cart(5000) });
    await makeSession({ restaurantId: rid, lastActivityAt: new Date(t), hiddenAt: new Date(t), status: 'ended', cart: cart(99999) });
    const { summary } = (await call('GET', `/api/owner/${rid}/live/sessions`, owner)).body.data;
    assert.deepEqual(summary, { live: 3, cartsInProgress: 2, cartsTotalPaise: 42000, abandonedLastHour: 0 });
  });

  test('the list makes the same small number of queries for 5 rows and for 50', async () => {
    const { restaurant } = await setup();
    for (let i = 0; i < 60; i += 1) {
      const user = i % 7 === 0 ? await makeGuest() : await makeCustomer(i % 5 === 0 ? { preferences: { shareActivity: false } } : {});
      await makeSession({ restaurantId: restaurant._id, userId: user._id, isGuest: i % 7 === 0, lastActivityAt: new Date(t - i * 1000) });
      if (i % 3 === 0) await seedOffer(restaurant, user, new Date(t - i * 1000));
    }
    const count = async (limit) => {
      let n = 0;
      mongoose.set('debug', () => {
        n += 1;
      });
      try {
        const { sessions } = await offers.listSessions(restaurant._id, { limit });
        assert.equal(sessions.length, limit);
      } finally {
        mongoose.set('debug', false);
      }
      return n;
    };
    const small = await count(5);
    const large = await count(50);
    assert.equal(large, small);
    assert.ok(large <= 5, `${large} queries`);
  });

  test('session detail: header row, full cart, offers in this session', async () => {
    const { owner, restaurant, session, paneer } = await setup({
      session: { cart: { items: [], totalPaise: 0 }, cameFromSearch: 'paneer' },
    });
    await CustomerSession.updateOne(
      { _id: session._id },
      { $set: { cart: { items: [{ menuItemId: paneer._id, name: 'Paneer Tikka', qty: 2, unitPricePaise: 25000 }], totalPaise: 54000, updatedAt: new Date(t) } } }
    );
    const sent = await send(owner, restaurant, offerBody(session));
    const res = await call('GET', `/api/owner/${restaurant._id}/live/sessions/${session._id}`, owner);
    assert.equal(res.status, 200);
    const { session: header, cart, offers: list } = res.body.data;
    assert.equal(header.id, String(session._id));
    assert.equal(header.cameFromSearch, 'paneer');
    assert.equal(header.notEligibleReason, 'OFFER_OPEN');
    assert.deepEqual(cart.items, [{ menuItemId: String(paneer._id), name: 'Paneer Tikka', qty: 2, unitPricePaise: 25000 }]);
    assert.equal(cart.totalPaise, 54000);
    assert.deepEqual(list.map((o) => [o.id, o.status]), [[sent.body.data.offer.id, 'sent']]);
  });

  test('events: newest first, paged backwards with ties on `at` broken by id', async () => {
    const { owner, restaurant, session, customer } = await setup();
    const at = (ms) => new Date(T0 + ms);
    const docs = [0, 1000, 1000, 1000, 2000, 3000, 4000].map((ms, i) => ({
      sessionId: session._id,
      restaurantId: restaurant._id,
      userId: customer._id,
      type: 'menu_searched',
      label: `e${i}`,
      data: { query: `q${i}` },
      at: at(ms),
    }));
    await ActivityEvent.create(docs);
    const all = await ActivityEvent.find({ sessionId: session._id }).sort({ at: -1, _id: -1 }).lean();

    const seen = [];
    let before = '';
    for (let page = 0; page < 5; page += 1) {
      const res = await call('GET', `/api/owner/${restaurant._id}/live/sessions/${session._id}/events?limit=2${before ? `&before=${before}` : ''}`, owner);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      seen.push(...res.body.data.events.map((e) => e.id));
      before = res.body.data.nextBefore;
      if (!before) break;
    }
    assert.deepEqual(seen, all.map((e) => String(e._id)), 'every event once, in order');
    const [first] = (await call('GET', `/api/owner/${restaurant._id}/live/sessions/${session._id}/events?limit=1`, owner)).body.data.events;
    assert.deepEqual(Object.keys(first).sort(), ['at', 'data', 'id', 'label', 'type']);
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/sessions/${session._id}/events?before=garbage`, owner), 400, 'VALIDATION_ERROR');
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/sessions/${session._id}/events?limit=101`, owner), 400, 'VALIDATION_ERROR');
  });

  test('offer history: personal offers only, newest first, IST range ≤ 90 days, names and order totals', async () => {
    const { owner, restaurant, session, customer } = await setup();
    const order = await Order.collection.insertOne({ restaurantId: restaurant._id, userId: customer._id, status: 'delivered', charges: { grandTotal: 48600 } });
    await seedOffer(restaurant, customer, new Date(T0 - 2 * DAY), { sessionId: session._id, offerStatus: 'redeemed', redeemedAt: new Date(T0 - 2 * DAY), orderId: order.insertedId });
    await seedOffer(restaurant, customer, new Date(T0 - DAY), { sessionId: session._id });
    await seedOffer(restaurant, customer, new Date(T0 - 40 * DAY), { sessionId: session._id });
    await Discount.create({ restaurantId: restaurant._id, offerName: 'Public', type: 'percentage', percentage: 5, status: 'active' });

    const res = await call('GET', `/api/owner/${restaurant._id}/live/offers`, owner);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.data.offers;
    assert.equal(rows.length, 2, 'last 30 days, personal only');
    assert.equal(rows[0].sentAt, new Date(T0 - DAY).toISOString());
    assert.equal(rows[1].customerName, 'Aarav');
    assert.equal(rows[1].orderTotalPaise, 48600);
    assert.equal(rows[1].status, 'redeemed');

    const wide = await call('GET', `/api/owner/${restaurant._id}/live/offers?from=2026-09-01&to=2026-10-27`, owner);
    assert.equal(wide.body.data.offers.length, 3);
    const paged = await call('GET', `/api/owner/${restaurant._id}/live/offers?from=2026-09-01&to=2026-10-27&limit=2&page=2`, owner);
    assert.equal(paged.body.data.offers.length, 1);
    assert.equal(paged.body.data.hasMore, false);
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/offers?from=2026-07-01&to=2026-10-27`, owner), 400, 'VALIDATION_ERROR');
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/offers?from=2026-10-27&to=2026-10-01`, owner), 400, 'VALIDATION_ERROR');
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/offers?limit=51`, owner), 400, 'VALIDATION_ERROR');
  });

  test('metrics: counts by stage and money for a seeded mix across ranges', async () => {
    const { owner, restaurant, customer } = await setup();
    const at = (ago) => new Date(T0 - ago);
    const orderFor = async (status, grandTotal, discount) =>
      (await Order.collection.insertOne({ restaurantId: restaurant._id, status, charges: { grandTotal, food: { discount } } })).insertedId;

    // Today (15:30 IST now): sent ×5 — one viewed only, one applied, two redeemed (one order cancelled), one revoked.
    await seedOffer(restaurant, customer, at(10 * MINUTE), { offerStatus: 'viewed', viewedAt: at(9 * MINUTE) });
    await seedOffer(restaurant, customer, at(20 * MINUTE), { offerStatus: 'applied', deliveredAt: at(19 * MINUTE), viewedAt: at(18 * MINUTE), appliedAt: at(17 * MINUTE) });
    await seedOffer(restaurant, customer, at(30 * MINUTE), { offerStatus: 'redeemed', deliveredAt: at(29 * MINUTE), viewedAt: at(28 * MINUTE), appliedAt: at(27 * MINUTE), redeemedAt: at(26 * MINUTE), orderId: await orderFor('delivered', 50000, 5000) });
    await seedOffer(restaurant, customer, at(40 * MINUTE), { offerStatus: 'redeemed', appliedAt: at(39 * MINUTE), redeemedAt: at(38 * MINUTE), orderId: await orderFor('cancelled', 90000, 9000) });
    await seedOffer(restaurant, customer, at(50 * MINUTE), { offerStatus: 'revoked', revokedAt: at(45 * MINUTE) });
    // 3 days ago: one expired, one redeemed.
    await seedOffer(restaurant, customer, at(3 * DAY), { offerStatus: 'expired' });
    await seedOffer(restaurant, customer, at(3 * DAY + MINUTE), { offerStatus: 'redeemed', redeemedAt: at(3 * DAY), orderId: await orderFor('delivered', 30000, 3000) });
    // 20 days ago: one expired. Another restaurant's offer never counts.
    await seedOffer(restaurant, customer, at(20 * DAY), { offerStatus: 'expired' });
    const other = await makeRestaurant({ name: 'Other' });
    await seedOffer(other.restaurant, customer, at(MINUTE), { offerStatus: 'redeemed', redeemedAt: at(MINUTE) });

    const get = async (range) => {
      const res = await call('GET', `/api/owner/${restaurant._id}/live/metrics${range ? `?range=${range}` : ''}`, owner);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data;
    };
    const today = await get();
    assert.equal(today.range, 'today');
    assert.equal(today.from, '2026-10-26T18:30:00.000Z', 'IST midnight');
    assert.deepEqual(
      [today.sent, today.delivered, today.viewed, today.applied, today.redeemed, today.expired, today.revoked],
      [5, 4, 4, 3, 2, 0, 1]
    );
    assert.equal(today.conversionRate, 0.4);
    assert.equal(today.revenuePaise, 50000, 'the cancelled order is left out');
    assert.equal(today.discountPaise, 5000);

    const week = await get('7d');
    assert.deepEqual([week.sent, week.redeemed, week.expired], [7, 3, 1]);
    assert.equal(week.conversionRate, 0.4286);
    assert.equal(week.revenuePaise, 80000);
    assert.equal(week.discountPaise, 8000);

    const month = await get('30d');
    assert.deepEqual([month.sent, month.expired], [8, 2]);
    assert.equal(month.conversionRate, 0.375);

    const empty = await call('GET', `/api/owner/${other.restaurant._id}/live/metrics?range=7d`, other.owner);
    assert.equal(empty.body.data.sent, 1);
    expectError(await call('GET', `/api/owner/${restaurant._id}/live/metrics?range=1y`, owner), 400, 'VALIDATION_ERROR');
  });
});

// ─── Old Live Monitor endpoints (AT) ───────────────────────────────────────

test('POST /live-monitor/offer is gone; GET /live-monitor/visitors lists open sessions with the old keys and no PII', async () => {
  const { owner, restaurant, session } = await setup();
  const path = `/api/owner/${restaurant._id}/live-monitor`;
  const gone = await call('POST', `${path}/offer`, owner, {
    offerName: 'Happy hour',
    type: 'percentage',
    percentage: 15,
    startDate: new Date(T0).toISOString(),
    endDate: new Date(T0 + 30 * MINUTE).toISOString(),
  });
  expectError(gone, 404, 'NOT_FOUND');
  assert.equal(await Discount.countDocuments(), 0);

  await makeSession({ restaurantId: restaurant._id, status: 'ended' });
  await makeSession({ restaurantId: restaurant._id, hiddenAt: new Date(t), status: 'ended' });
  const res = await call('GET', `${path}/visitors`, owner);
  assert.equal(res.status, 200);
  const { visitors, count } = res.body.data;
  assert.equal(count, 1, 'open sessions only');
  const [visitor] = visitors;
  assert.equal(visitor.sessionId, String(session._id));
  assert.equal(visitor.userId, String(session._id), 'a per-visit key, not the customer id');
  assert.equal(visitor.name, 'Aarav');
  assert.equal(visitor.lastSeen, Math.floor(T0 / 1000));
  assert.equal(visitor.tableId, null);
  assert.ok(visitor.offerEligible !== undefined, 'plus the new session-row fields');
  const text = JSON.stringify(res.body);
  assert.ok(!/email|phone/.test(text));
  assert.ok(!text.includes(String(session.userId)));

  live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
  assert.deepEqual((await call('GET', `${path}/visitors`, owner)).body.data, { visitors: [], count: 0 });
});

test('GET /live-monitor/repeat: first name and order count only — no email or phone', async () => {
  const { owner, restaurant } = await setup();
  const regular = await makeCustomer({ name: 'Priya Sharma', email: 'priya@example.com' });
  const once = await makeCustomer({ name: 'One Timer' });
  const raw = (userId) => ({ restaurantId: restaurant._id, userId, status: 'delivered', createdAt: new Date(T0) });
  await Order.collection.insertMany([raw(regular._id), raw(regular._id), raw(regular._id), raw(once._id)]);

  const res = await call('GET', `/api/owner/${restaurant._id}/live-monitor/repeat`, owner);
  assert.equal(res.status, 200);
  const { visitors } = res.body.data;
  assert.equal(visitors.length, 1);
  assert.deepEqual(Object.keys(visitors[0]).sort(), ['_id', 'lastOrder', 'name', 'orderCount']);
  assert.equal(visitors[0].name, 'Priya');
  assert.equal(visitors[0].orderCount, 3);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('priya@example.com') && !text.includes(regular.phone) && !/email|phone/.test(text));
});
