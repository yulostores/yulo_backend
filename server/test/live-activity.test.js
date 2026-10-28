// Live customer activity — A2: activity capture inside the existing customer endpoints. Each
// hooked endpoint writes exactly one event on the right restaurant's session; untracked callers,
// opted-out customers, pilot-excluded restaurants and the switch being off write nothing;
// coalescing (Redis and the in-process fallback), the 30-minute timeout, concurrent first
// events, the restaurant switch, search attribution, error isolation and conversion.
// In-memory MongoDB, the real HTTP API, a fake clock and (where named) a fake Redis.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { generateTokens, generateStaffToken, generatePartnerTokens } = await import('../services/auth.service.js');
const { default: logger } = await import('../utils/logger.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: User } = await import('../models/User.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');
const {
  ObjectId,
  authHeader,
  makeCustomer,
  makeDeliveryCustomer,
  makeGuest,
  makeRestaurant,
  createFakeRedis,
} = await import('../test-utils/liveFixtures.mjs');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

let mongo;
let srv;
let t; // the fake clock's current time (ms)

const tick = (ms) => {
  t += ms;
};

const call = async (method, path, user, body, extraHeaders = {}) => {
  const headers = { ...(user ? authHeader(user) : {}), ...extraHeaders };
  const res = await srv.request(method, path, { headers, body });
  await activity.__flushForTests();
  return res;
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

const eventsOf = (filter = {}) => ActivityEvent.find(filter).sort({ at: 1, _id: 1 }).lean();
const sessionsOf = (filter = {}) => CustomerSession.find(filter).sort({ startedAt: 1, _id: 1 }).lean();
const openSessionOf = (user, restaurant) =>
  CustomerSession.findOne({ userId: user._id, restaurantId: restaurant._id, isOpen: true }).lean();

const enableCod = async () => {
  const admin = await User.create({ name: 'Admin', email: `admin${Date.now()}@test.local`, role: 'admin' });
  const res = await srv.request('POST', '/api/admin/finance/settings', {
    headers: { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` },
    body: { settings: { codEnabled: true }, note: 'COD for live activity tests' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
};

before(async () => {
  mongo = await startMemoryMongo();
  // Unique indexes the tests rely on (one open session; one order per Idempotency-Key).
  await Promise.all([CustomerSession.init(), ActivityEvent.init(), IdempotencyKey.init()]);
  srv = await startTestServer({ withSocket: true });
});

after(async () => {
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  activity.__setRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  t = Date.parse('2026-10-27T10:00:00Z');
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null); // in-process windows unless a test installs a fake Redis
  activity.__resetWindowsForTests();
});

// ─── Each endpoint writes one event ────────────────────────────────────────

describe('each hooked endpoint writes exactly one event on the right session', () => {
  test('browse → cart → checkout → order, one event per step, snapshot matches the bill', async () => {
    const { restaurant, paneer, naan } = await makeRestaurant();
    const customer = await makeDeliveryCustomer();
    await enableCod();
    const rid = String(restaurant._id);
    let seen = 0;

    // One new event of `type` on this restaurant; the session mirrors it.
    const expectEvent = async (type, label) => {
      const events = await eventsOf({ userId: customer._id });
      assert.equal(events.length, seen + 1, `one new event for ${type}: ${events.map((e) => e.type)}`);
      seen += 1;
      const event = events.at(-1);
      assert.equal(event.type, type);
      assert.equal(String(event.restaurantId), rid);
      if (label) assert.equal(event.label, label);
      const session = await CustomerSession.findById(event.sessionId).lean();
      assert.equal(session.lastEvent.type, type);
      assert.equal(session.eventCount, seen);
      return { event, session };
    };

    ok(await call('GET', `/api/restaurants/${rid}`, customer));
    await expectEvent('restaurant_viewed', 'Viewed menu');

    ok(await call('GET', `/api/restaurants/${rid}/menu/search?q=${encodeURIComponent('  pan\u0007eer  ')}`, customer));
    const searched = await expectEvent('menu_searched');
    assert.equal(searched.event.data.query, 'pan eer', 'trimmed, control characters removed');

    ok(await call('GET', `/api/items/${paneer._id}`, customer));
    const viewed = await expectEvent('item_viewed', 'Viewed Paneer Tikka');
    assert.equal(String(viewed.event.data.menuItemId), String(paneer._id));

    const added = ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 2 }), 201);
    assert.deepEqual(Object.keys(added), ['cart', 'bill'], 'response shape unchanged');
    const add = await expectEvent('cart_item_added', 'Added Paneer Tikka ×2');
    assert.equal(add.session.cart.items.length, 1);
    assert.equal(add.session.cart.items[0].unitPricePaise, 25000);
    assert.equal(add.session.cart.totalPaise, added.bill.charges.grandTotal, 'total from the response bill');
    const lineId = added.cart.items[0]._id;

    const changed = ok(await call('PATCH', `/api/cart/items/${lineId}`, customer, { qty: 3 }));
    assert.deepEqual(Object.keys(changed), ['cart', 'bill'], 'no `previous` leaks into the response');
    const qty = await expectEvent('cart_qty_changed', 'Changed Paneer Tikka to ×3');
    assert.equal(qty.event.data.deltaQty, 1);
    assert.equal(qty.session.cart.totalPaise, changed.bill.charges.grandTotal);

    const withNaan = ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(naan._id), qty: 1 }), 201);
    await expectEvent('cart_item_added', 'Added Butter Naan ×1');
    const naanLine = withNaan.cart.items.find((i) => String(i.menuItemId) === String(naan._id))._id;

    const removed = ok(await call('DELETE', `/api/cart/items/${naanLine}`, customer));
    const rm = await expectEvent('cart_item_removed', 'Removed Butter Naan');
    assert.equal(rm.event.data.deltaQty, -1);
    assert.equal(rm.session.cart.items.length, 1);
    assert.equal(rm.session.cart.totalPaise, removed.bill.charges.grandTotal);

    const summary = ok(await call('GET', '/api/checkout/summary', customer));
    const started = await expectEvent('checkout_started', 'Started checkout');
    assert.ok(started.session.checkoutStartedAt, 'checkoutStartedAt set');
    assert.equal(started.session.cart.totalPaise, summary.bill.charges.grandTotal);

    const placed = ok(
      await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod' }, { 'Idempotency-Key': 'live-a2-1' }),
      201
    );
    const order = await expectEvent('order_placed', 'Placed order');
    assert.equal(order.session.status, 'converted');
    assert.equal(order.session.isOpen, false);
    assert.equal(String(order.session.orderId), String(placed.orderId));
    assert.equal(String(order.event.data.orderId), String(placed.orderId));

    // An Idempotency-Key replay returns the same order and records nothing.
    const replay = ok(
      await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod' }, { 'Idempotency-Key': 'live-a2-1' })
    );
    assert.equal(String(replay.order.orderId), String(placed.orderId));
    assert.equal((await eventsOf({ userId: customer._id })).length, seen, 'no second order_placed');

    // The order emptied the cart: clearing an empty cart records nothing.
    ok(await call('DELETE', '/api/cart', customer));
    assert.equal((await eventsOf({ userId: customer._id })).length, seen);
    assert.equal((await sessionsOf()).length, 1);
  });

  test('PATCH qty 0 removes the line and is recorded as cart_item_removed', async () => {
    const { restaurant, paneer } = await makeRestaurant();
    const customer = await makeCustomer();
    const added = ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 2 }), 201);
    ok(await call('PATCH', `/api/cart/items/${added.cart.items[0]._id}`, customer, { qty: 0 }));

    const events = await eventsOf();
    assert.deepEqual(events.map((e) => e.type), ['cart_item_added', 'cart_item_removed']);
    assert.equal(events[1].data.deltaQty, -2);
    assert.equal(String(events[1].restaurantId), String(restaurant._id), 'the restaurant from before the cart emptied');
  });

  test('DELETE /api/cart records cart_cleared on the restaurant read before clearing', async () => {
    const { restaurant, paneer } = await makeRestaurant();
    const customer = await makeCustomer();
    ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 }), 201);
    ok(await call('DELETE', '/api/cart', customer));

    const events = await eventsOf();
    assert.deepEqual(events.map((e) => e.type), ['cart_item_added', 'cart_cleared']);
    assert.equal(String(events[1].restaurantId), String(restaurant._id));
    const session = await openSessionOf(customer, restaurant);
    assert.deepEqual(session.cart.items, [], 'snapshot follows the cleared cart');
    assert.equal(session.cart.totalPaise, 0);
  });

  test('guests are tracked, shown as "Guest", with no past orders', async () => {
    const { restaurant } = await makeRestaurant();
    const guest = await makeGuest({ name: 'Rahul Verma' });
    ok(await call('GET', `/api/restaurants/${restaurant._id}`, guest));
    const [session] = await sessionsOf();
    assert.equal(session.displayName, 'Guest');
    assert.equal(session.isGuest, true);
    assert.equal(session.pastOrderCount, 0);
  });

  test('displayName is the first name (≤20 chars), "Customer" without one — never the phone', async () => {
    const { restaurant } = await makeRestaurant();
    const cases = [
      [{ name: '  Aarav   Sharma ' }, 'Aarav'],
      [{ name: 'Venkataramanasubramanian Iyer' }, 'Venkataramanasubrama'],
      [{ name: undefined }, 'Customer'],
      [{ name: '   ' }, 'Customer'],
    ];
    for (const [overrides, expected] of cases) {
      const customer = await makeCustomer(overrides);
      ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
      const session = await openSessionOf(customer, restaurant);
      assert.equal(session.displayName, expected);
      assert.ok(!session.displayName.includes(customer.phone));
    }
  });
});

// ─── Untracked callers write nothing ───────────────────────────────────────

describe('untracked requests write nothing', () => {
  test('anonymous, owner, waiter, chef, rider, opted-out, outside the allow-list', async () => {
    const { restaurant, owner, paneer } = await makeRestaurant();
    const optedOut = await makeCustomer({ preferences: { shareActivity: false } });
    const raw = (token) => ({ authorization: `Bearer ${token}` });
    const callers = {
      anonymous: {},
      owner: raw(generateTokens(owner._id, 'restaurant_owner').accessToken),
      waiter: raw(generateStaffToken(new ObjectId(), 'waiter', restaurant._id, 0)),
      chef: raw(generateStaffToken(new ObjectId(), 'chef', restaurant._id, 0)),
      rider: raw(generatePartnerTokens(new ObjectId()).accessToken),
      optedOut: authHeader(optedOut),
    };
    for (const [who, headers] of Object.entries(callers)) {
      for (const path of [`/api/restaurants/${restaurant._id}`, `/api/restaurants/${restaurant._id}/menu`, `/api/items/${paneer._id}`]) {
        const res = await srv.request('GET', path, { headers });
        assert.equal(res.status, 200, `${who} ${path}`);
      }
    }
    ok(await call('POST', '/api/cart/items', optedOut, { menuItemId: String(paneer._id), qty: 1 }), 201);
    ok(await call('GET', '/api/checkout/summary', optedOut));
    await activity.__flushForTests();

    // A pilot that doesn't include this restaurant.
    live.__setLiveActivityForTests({ enabled: true, restaurantIds: String(new ObjectId()) });
    const customer = await makeCustomer();
    ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
    ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 }), 201);

    assert.equal(await CustomerSession.countDocuments(), 0);
    assert.equal(await ActivityEvent.countDocuments(), 0);
  });

  test('an opted-out customer is not read beyond the preference check', async () => {
    const { restaurant } = await makeRestaurant();
    const optedOut = await makeCustomer({ preferences: { shareActivity: false } });
    const original = CustomerSession.findOne;
    let sessionReads = 0;
    CustomerSession.findOne = function counted(...args) {
      sessionReads += 1;
      return original.apply(this, args);
    };
    try {
      const result = await activity.record({ user: { _id: optedOut._id, role: 'customer', name: 'X' } }, restaurant._id, 'restaurant_viewed');
      assert.equal(result, null);
    } finally {
      CustomerSession.findOne = original;
    }
    assert.equal(sessionReads, 0);
  });

  test('turning sharing off drops the cached preference, so recording stops at once', async () => {
    const { restaurant, paneer } = await makeRestaurant();
    const customer = await makeCustomer();
    const redis = createFakeRedis();
    activity.__setRedisForTests(redis);

    ok(await call('GET', `/api/items/${paneer._id}`, customer));
    assert.equal(await redis.get(`liveact:pref:${customer._id}`), '1', 'cached for 60 s');

    ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
    assert.equal(await redis.get(`liveact:pref:${customer._id}`), null, 'cache entry dropped');

    tick(2 * MINUTE);
    ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
    assert.deepEqual((await eventsOf()).map((e) => e.type), ['item_viewed']);
  });
});

// ─── Switch off: nothing written, bodies unchanged ─────────────────────────

describe('with the switch off', () => {
  // Ids, timestamps and the cart document's version differ between two runs (the second
  // reuses the same cart); everything else must be identical.
  const normalize = (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/"[a-f\d]{24}"/g, '"<id>"')
        .replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<date>"')
        .replace(/"__v":\d+/g, '"__v":0')
    );

  const runAll = async (customer, { restaurant, paneer, naan }) => {
    const rid = restaurant._id;
    const bodies = {};
    const take = async (name, method, path, body, status = 200) => {
      const res = await call(method, path, customer, body);
      assert.equal(res.status, status, `${name}: ${JSON.stringify(res.body).slice(0, 200)}`);
      bodies[name] = normalize(res.body);
      return res.body.data;
    };
    await take('restaurant', 'GET', `/api/restaurants/${rid}`);
    await take('menu', 'GET', `/api/restaurants/${rid}/menu`);
    await take('menuSearch', 'GET', `/api/restaurants/${rid}/menu/search?q=paneer`);
    await take('search', 'GET', '/api/restaurants?q=Spice');
    await take('item', 'GET', `/api/items/${paneer._id}`);
    const added = await take('add', 'POST', '/api/cart/items', { menuItemId: String(paneer._id), qty: 2 }, 201);
    await take('add2', 'POST', '/api/cart/items', { menuItemId: String(naan._id), qty: 1 }, 201);
    await take('qty', 'PATCH', `/api/cart/items/${added.cart.items[0]._id}`, { qty: 3 });
    const naanLine = (await call('GET', '/api/cart', customer)).body.data.cart.items.find(
      (i) => String(i.menuItemId) === String(naan._id)
    )._id;
    await take('remove', 'DELETE', `/api/cart/items/${naanLine}`);
    await take('summary', 'GET', '/api/checkout/summary');
    await take('clear', 'DELETE', '/api/cart');
    return bodies;
  };

  test('nothing is written and every response body is the same as with it on', async () => {
    const fixtures = await makeRestaurant();
    const customer = await makeDeliveryCustomer();

    live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
    const off = await runAll(customer, fixtures);
    assert.equal(await CustomerSession.countDocuments(), 0);
    assert.equal(await ActivityEvent.countDocuments(), 0);

    live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
    const on = await runAll(customer, fixtures);
    assert.ok((await ActivityEvent.countDocuments()) > 0, 'the same run with the switch on records');

    for (const name of Object.keys(off)) assert.deepEqual(on[name], off[name], name);
  });
});

// ─── Failed requests ───────────────────────────────────────────────────────

test('failed requests (404 item, invalid qty, unknown line, empty menu query) record nothing', async () => {
  const { restaurant } = await makeRestaurant();
  const customer = await makeCustomer();
  assert.equal((await call('GET', `/api/items/${new ObjectId()}`, customer)).status, 404);
  assert.equal((await call('PATCH', `/api/cart/items/${new ObjectId()}`, customer, { qty: -1 })).status, 400);
  assert.equal((await call('PATCH', `/api/cart/items/${new ObjectId()}`, customer, { qty: 2 })).status, 404);
  assert.equal((await call('DELETE', `/api/cart/items/${new ObjectId()}`, customer)).status, 404);
  assert.equal((await call('POST', '/api/cart/items', customer, { menuItemId: String(new ObjectId()), qty: 1 })).status, 404);
  assert.equal((await call('GET', `/api/restaurants/${restaurant._id}/menu/search?q=%20`, customer)).status, 400);
  assert.equal(await ActivityEvent.countDocuments(), 0);
  assert.equal(await CustomerSession.countDocuments(), 0);
});

// ─── Coalescing ────────────────────────────────────────────────────────────

for (const mode of ['in-process windows', 'Redis']) {
  describe(`coalescing (${mode})`, () => {
    beforeEach(() => {
      if (mode === 'Redis') activity.__setRedisForTests(createFakeRedis());
    });

    test('two views of an item within 60 s → one event; after 61 s → two', async () => {
      const { paneer } = await makeRestaurant();
      const customer = await makeCustomer();
      ok(await call('GET', `/api/items/${paneer._id}`, customer));
      tick(30 * SECOND);
      ok(await call('GET', `/api/items/${paneer._id}`, customer));
      assert.equal(await ActivityEvent.countDocuments({ type: 'item_viewed' }), 1);
      tick(31 * SECOND);
      ok(await call('GET', `/api/items/${paneer._id}`, customer));
      assert.equal(await ActivityEvent.countDocuments({ type: 'item_viewed' }), 2);
    });

    test('different items are not folded together', async () => {
      const { paneer, naan } = await makeRestaurant();
      const customer = await makeCustomer();
      ok(await call('GET', `/api/items/${paneer._id}`, customer));
      ok(await call('GET', `/api/items/${naan._id}`, customer));
      assert.equal(await ActivityEvent.countDocuments({ type: 'item_viewed' }), 2);
    });

    test('GET /restaurants/:id + /menu together → one restaurant_viewed', async () => {
      const { restaurant } = await makeRestaurant();
      const customer = await makeCustomer();
      await Promise.all([
        srv.request('GET', `/api/restaurants/${restaurant._id}`, { headers: authHeader(customer) }),
        srv.request('GET', `/api/restaurants/${restaurant._id}/menu`, { headers: authHeader(customer) }),
      ]);
      await activity.__flushForTests();
      assert.equal(await ActivityEvent.countDocuments({ type: 'restaurant_viewed' }), 1);
      assert.equal((await sessionsOf()).length, 1);
    });

    test('checkout_started at most once per 60 s', async () => {
      const { paneer } = await makeRestaurant();
      const customer = await makeDeliveryCustomer();
      ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 }), 201);
      ok(await call('GET', '/api/checkout/summary', customer));
      tick(20 * SECOND);
      ok(await call('GET', '/api/checkout/summary', customer));
      assert.equal(await ActivityEvent.countDocuments({ type: 'checkout_started' }), 1);
      tick(41 * SECOND);
      ok(await call('GET', '/api/checkout/summary', customer));
      assert.equal(await ActivityEvent.countDocuments({ type: 'checkout_started' }), 2);
    });

    test('a coalesced view refreshes lastActivityAt at most once per 30 s', async () => {
      const { restaurant, paneer } = await makeRestaurant();
      const customer = await makeCustomer();
      const start = t;
      ok(await call('GET', `/api/items/${paneer._id}`, customer));
      tick(10 * SECOND);
      ok(await call('GET', `/api/items/${paneer._id}`, customer)); // coalesced, refreshes (first refresh)
      assert.equal((await openSessionOf(customer, restaurant)).lastActivityAt.getTime(), start + 10 * SECOND);
      tick(10 * SECOND);
      ok(await call('GET', `/api/items/${paneer._id}`, customer)); // coalesced, inside the 30 s refresh window
      assert.equal((await openSessionOf(customer, restaurant)).lastActivityAt.getTime(), start + 10 * SECOND);
      tick(25 * SECOND);
      ok(await call('GET', `/api/items/${paneer._id}`, customer)); // coalesced, refresh window over
      assert.equal((await openSessionOf(customer, restaurant)).lastActivityAt.getTime(), start + 45 * SECOND);
      assert.equal(await ActivityEvent.countDocuments(), 1);
    });
  });
}

test('the in-process window map stays bounded (10 000 keys, oldest dropped first)', async () => {
  assert.equal(await activity.__claimWindowForTests('first', MINUTE), true);
  assert.equal(await activity.__claimWindowForTests('first', MINUTE), false, 'held inside its window');
  for (let i = 0; i < 10_000; i += 1) await activity.__claimWindowForTests(`k${i}`, MINUTE);
  assert.equal(activity.__windowSizeForTests(), 10_000);
  assert.equal(await activity.__claimWindowForTests('first', MINUTE), true, 'the oldest key was dropped');
});

// ─── Timeout, concurrency, switch ──────────────────────────────────────────

test('31 min of silence: the old session is closed (abandoned with a cart) and a new one opens', async () => {
  const { restaurant, paneer } = await makeRestaurant();
  const customer = await makeCustomer();
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 }), 201);
  const first = await openSessionOf(customer, restaurant);

  tick(31 * MINUTE);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));

  const old = await CustomerSession.findById(first._id).lean();
  assert.equal(old.status, 'abandoned');
  assert.equal(old.isOpen, false);
  assert.equal(old.lastEvent.type, 'cart_abandoned');
  const abandonedEvents = await eventsOf({ sessionId: first._id, type: 'cart_abandoned' });
  assert.equal(abandonedEvents.length, 1);

  const fresh = await openSessionOf(customer, restaurant);
  assert.notEqual(String(fresh._id), String(first._id));
  assert.equal(fresh.lastEvent.type, 'restaurant_viewed');
  assert.equal(fresh.eventCount, 1);
});

test('31 min of silence with an empty cart: the old session is ended, no cart_abandoned', async () => {
  const { restaurant } = await makeRestaurant();
  const customer = await makeCustomer();
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  const first = await openSessionOf(customer, restaurant);

  tick(31 * MINUTE);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));

  assert.equal((await CustomerSession.findById(first._id).lean()).status, 'ended');
  assert.equal(await ActivityEvent.countDocuments({ type: 'cart_abandoned' }), 0);
  assert.equal((await sessionsOf()).length, 2);
});

test('two concurrent first events for the same user + restaurant → one session, two events', async () => {
  const { restaurant } = await makeRestaurant();
  const customer = await makeCustomer();
  const req = { user: { _id: customer._id, role: 'customer', name: 'Aarav' } };
  const results = await Promise.all([
    activity.record(req, restaurant._id, 'menu_searched', { query: 'paneer' }),
    activity.record(req, restaurant._id, 'menu_searched', { query: 'naan' }),
    activity.record(req, restaurant._id, 'menu_searched', { query: 'dal' }),
  ]);
  assert.ok(results.every(Boolean), 'all three recorded (no E11000 escaped)');
  const sessions = await sessionsOf();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].eventCount, 3);
  assert.equal(await ActivityEvent.countDocuments({ sessionId: sessions[0]._id }), 3);
});

test('restaurant switch: the 409 records nothing, then cart_cleared on A and cart_item_added on B', async () => {
  const a = await makeRestaurant({ name: 'Spice Route' });
  const b = await makeRestaurant({ name: 'Tandoor House' });
  const customer = await makeCustomer();
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(a.paneer._id), qty: 1 }), 201);

  const conflict = await call('POST', '/api/cart/items', customer, { menuItemId: String(b.paneer._id), qty: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CART_RESTAURANT_CONFLICT');
  assert.equal(await ActivityEvent.countDocuments(), 1, 'nothing for the refused add');

  ok(await call('DELETE', '/api/cart', customer));
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(b.paneer._id), qty: 1 }), 201);

  const events = await eventsOf();
  assert.deepEqual(
    events.map((e) => [e.type, String(e.restaurantId)]),
    [
      ['cart_item_added', String(a.restaurant._id)],
      ['cart_cleared', String(a.restaurant._id)],
      ['cart_item_added', String(b.restaurant._id)],
    ]
  );
});

// ─── Search attribution ────────────────────────────────────────────────────

describe('search attribution', () => {
  let a;
  let b;
  beforeEach(async () => {
    activity.__setRedisForTests(createFakeRedis());
    a = await makeRestaurant({ name: 'Spice Route' });
    b = await makeRestaurant({ name: 'Tandoor House' });
  });

  test('search alone writes no event and no session', async () => {
    const customer = await makeCustomer();
    const found = ok(await call('GET', '/api/restaurants?q=Spice', customer));
    assert.deepEqual(found.restaurants.map((r) => r.name), ['Spice Route']);
    assert.equal(await CustomerSession.countDocuments(), 0);
    assert.equal(await ActivityEvent.countDocuments(), 0);
  });

  test('opening a restaurant that was in the results sets cameFromSearch once', async () => {
    const customer = await makeCustomer();
    ok(await call('GET', `/api/restaurants?q=${encodeURIComponent('  Spice ')}`, customer));
    ok(await call('GET', `/api/restaurants/${a.restaurant._id}`, customer));
    assert.equal((await openSessionOf(customer, a.restaurant)).cameFromSearch, 'Spice');

    // A later search that also matches doesn't overwrite it.
    tick(2 * MINUTE);
    ok(await call('GET', '/api/restaurants?q=Route', customer));
    ok(await call('GET', `/api/restaurants/${a.restaurant._id}`, customer));
    assert.equal((await openSessionOf(customer, a.restaurant)).cameFromSearch, 'Spice');
  });

  test('opening a restaurant that was not in the results leaves it unset', async () => {
    const customer = await makeCustomer();
    ok(await call('GET', '/api/restaurants?q=Spice', customer));
    ok(await call('GET', `/api/restaurants/${b.restaurant._id}`, customer));
    assert.equal((await openSessionOf(customer, b.restaurant)).cameFromSearch, null);
  });

  test('after 11 minutes the search no longer counts', async () => {
    const customer = await makeCustomer();
    ok(await call('GET', '/api/restaurants?q=Spice', customer));
    tick(11 * MINUTE);
    ok(await call('GET', `/api/restaurants/${a.restaurant._id}`, customer));
    assert.equal((await openSessionOf(customer, a.restaurant)).cameFromSearch, null);
  });

  test('without Redis the search is skipped silently', async () => {
    activity.__setRedisForTests(null);
    const customer = await makeCustomer();
    ok(await call('GET', '/api/restaurants?q=Spice', customer));
    ok(await call('GET', `/api/restaurants/${a.restaurant._id}`, customer));
    assert.equal((await openSessionOf(customer, a.restaurant)).cameFromSearch, null);
  });
});

// ─── Errors never reach the customer ───────────────────────────────────────

test('a failure inside record → same 200 body, a warning with ids only', async () => {
  const { paneer } = await makeRestaurant();
  const customer = await makeCustomer();

  live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
  const baseline = ok(await call('GET', `/api/items/${paneer._id}`, customer));
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });

  const originalCreate = ActivityEvent.create;
  const originalWarn = logger.warn;
  const warnings = [];
  ActivityEvent.create = async () => {
    throw new Error('simulated write failure');
  };
  logger.warn = (obj, msg) => warnings.push({ obj, msg });
  try {
    const res = await call('GET', `/api/items/${paneer._id}`, customer);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, baseline);
  } finally {
    ActivityEvent.create = originalCreate;
    logger.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'live activity: record failed');
  assert.equal(warnings[0].obj.userId, String(customer._id));
  assert.equal(warnings[0].obj.type, 'item_viewed');
  assert.ok(!JSON.stringify(warnings[0].obj).includes(customer.phone), 'no PII in the log');
});

// ─── Conversion ────────────────────────────────────────────────────────────

test('order_placed with no open session opens one and marks it converted at once', async () => {
  const { restaurant, paneer } = await makeRestaurant();
  const customer = await makeDeliveryCustomer({ name: 'Meera' });
  await enableCod();

  // The whole visit happened before the switch was turned on.
  live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 1 }), 201);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });

  const placed = ok(await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod' }), 201);
  const [session] = await sessionsOf();
  assert.equal(String(session.restaurantId), String(restaurant._id));
  assert.equal(session.status, 'converted');
  assert.equal(session.isOpen, false);
  assert.equal(String(session.orderId), String(placed.orderId));
  assert.equal(session.displayName, 'Meera');
  assert.deepEqual((await eventsOf()).map((e) => e.type), ['order_placed']);
});

test('pastOrderCount counts this customer\'s delivered orders at this restaurant', async () => {
  const { restaurant } = await makeRestaurant();
  const other = await makeRestaurant({ name: 'Elsewhere' });
  const customer = await makeCustomer();
  const { default: Order } = await import('../models/Order.js');
  const raw = (restaurantId, status) => ({ userId: customer._id, restaurantId, status, orderNumber: String(new ObjectId()) });
  await Order.collection.insertMany([
    raw(restaurant._id, 'delivered'),
    raw(restaurant._id, 'delivered'),
    raw(restaurant._id, 'cancelled'),
    raw(other.restaurant._id, 'delivered'),
  ]);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  assert.equal((await openSessionOf(customer, restaurant)).pastOrderCount, 2);
});

// ─── Coverage gaps closed in AT ────────────────────────────────────────────

test('free text is capped at 60 characters: the menu query and the search that led here', async () => {
  activity.__setRedisForTests(createFakeRedis());
  const { restaurant } = await makeRestaurant({ name: 'Spice Route' });
  const customer = await makeCustomer();
  const long = `Spice ${'x'.repeat(100)}`;
  ok(await call('GET', `/api/restaurants/${restaurant._id}/menu/search?q=${encodeURIComponent(long)}`, customer));
  const [event] = await eventsOf({ type: 'menu_searched' });
  assert.equal(event.data.query.length, 60);
  assert.equal(event.label, `Searched "${long.slice(0, 60)}"`);

  // A search whose results included this restaurant, then opened.
  const other = await makeCustomer();
  await activity.rememberSearch({ user: { _id: other._id, role: 'customer' } }, long, [restaurant._id]);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, other));
  assert.equal((await openSessionOf(other, restaurant)).cameFromSearch.length, 60);
});

test('every Redis key the feature writes is liveact:-prefixed and expires', async () => {
  const redis = createFakeRedis();
  activity.__setRedisForTests(redis);
  const { restaurant, paneer } = await makeRestaurant();
  const customer = await makeCustomer();
  ok(await call('GET', `/api/restaurants?q=Spice`, customer));
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  ok(await call('GET', `/api/items/${paneer._id}`, customer));
  ok(await call('GET', `/api/items/${paneer._id}`, customer)); // coalesced → the touch key
  const keys = [...redis.store.entries()];
  assert.ok(keys.length >= 4, keys.map(([k]) => k).join(', '));
  for (const [key, entry] of keys) {
    assert.ok(key.startsWith('liveact:'), key);
    assert.ok(!key.startsWith('live:'), key);
    assert.notEqual(entry.expiresAt, null, `${key} has no expiry`);
    assert.ok(entry.expiresAt - t <= 10 * MINUTE, `${key} lives at most 10 min`);
  }
});

test('turning sharing back on does not unhide old sessions; only new activity shows', async () => {
  const { restaurant } = await makeRestaurant();
  const customer = await makeCustomer();
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  const first = await openSessionOf(customer, restaurant);
  ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
  ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: true }));
  tick(MINUTE);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));

  const old = await CustomerSession.findById(first._id).lean();
  assert.ok(old.hiddenAt, 'still hidden');
  const fresh = await openSessionOf(customer, restaurant);
  assert.notEqual(String(fresh._id), String(first._id));
  assert.equal(fresh.hiddenAt, null);
});

test('there is no public endpoint that writes an event', async () => {
  const customer = await makeCustomer();
  for (const path of ['/api/activity', '/api/track', '/api/events', '/api/sessions', '/api/live', '/api/live/events']) {
    for (const method of ['POST', 'PUT']) {
      const res = await call(method, path, customer, { type: 'restaurant_viewed', restaurantId: String(new ObjectId()) });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  }
  assert.equal(await ActivityEvent.countDocuments(), 0);
});

// ─── Found in I1 ───────────────────────────────────────────────────────────

test('a customer who returns to a cart they filled earlier: the new session starts with that cart', async () => {
  const { restaurant, paneer } = await makeRestaurant();
  const customer = await makeDeliveryCustomer();
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 2 }), 201);
  const first = await openSessionOf(customer, restaurant);

  // Away long enough for the visit to end (abandoned, cart kept on the server).
  tick(31 * MINUTE);
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  const fresh = await openSessionOf(customer, restaurant);
  assert.notEqual(String(fresh._id), String(first._id));

  const { bill } = ok(await call('GET', '/api/cart', customer));
  assert.deepEqual(fresh.cart.items.map((l) => [l.name, l.qty, l.unitPricePaise]), [['Paneer Tikka', 2, 25000]]);
  assert.equal(fresh.cart.totalPaise, bill.charges.grandTotal, 'the server bill, not a recomputation');

  // A cart for another restaurant isn't carried into this one.
  const other = await makeRestaurant({ name: 'Elsewhere' });
  ok(await call('GET', `/api/restaurants/${other.restaurant._id}`, customer));
  assert.deepEqual((await openSessionOf(customer, other.restaurant)).cart.items, []);
});
