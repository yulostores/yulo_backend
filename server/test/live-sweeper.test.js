// Live customer activity — A3: the session sweeper (idle / abandoned / ended / checkout_left),
// its safety under overlapping runs and racing customer events, the per-tick batch limit, the
// owner read scope, and the one session-row shape. In-memory MongoDB and a fake clock.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const { toSessionRow } = await import('../services/liveSession.serializer.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { ObjectId, makeCustomer, makeSession } = await import('../test-utils/liveFixtures.mjs');

const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-10-27T10:00:00Z');

let mongo;
let t;

const at = (ms) => new Date(T0 + ms);
const sweep = () => activity.sweepSessions(clock.now());
const reload = (session) => CustomerSession.findById(session._id).lean();
const eventsOf = (session, type) => ActivityEvent.find({ sessionId: session._id, ...(type ? { type } : {}) }).lean();
const cartWith = (totalPaise = 54000) => ({
  items: [{ menuItemId: new ObjectId(), name: 'Paneer Tikka', qty: 2, unitPricePaise: 25000 }],
  totalPaise,
  updatedAt: at(0),
});

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CustomerSession.init(), ActivityEvent.init()]);
});

after(async () => {
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  activity.__setRedisForTests(undefined);
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  t = T0;
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
  activity.__resetWindowsForTests();
});

// ─── Transitions ───────────────────────────────────────────────────────────

describe('transitions', () => {
  test('4 min → still active; 6 min → idle with one went_idle, not repeated', async () => {
    const session = await makeSession({ lastActivityAt: at(0) });

    t = T0 + 4 * MINUTE;
    assert.deepEqual(await sweep(), { idled: 0, abandoned: 0, ended: 0, checkoutLeft: 0, expired: 0, scanned: 0 });
    assert.equal((await reload(session)).status, 'active');

    t = T0 + 6 * MINUTE;
    assert.equal((await sweep()).idled, 1);
    t = T0 + 7 * MINUTE;
    await sweep();

    const idle = await reload(session);
    assert.equal(idle.status, 'idle');
    assert.equal(idle.isOpen, true);
    assert.equal(idle.lastEvent.type, 'went_idle');
    assert.equal(idle.lastActivityAt.getTime(), T0, 'going idle is not activity');
    assert.equal(idle.eventCount, 1);
    assert.equal((await eventsOf(session, 'went_idle')).length, 1);
  });

  test('36 min with a cart → abandoned + one cart_abandoned carrying the cart total', async () => {
    const session = await makeSession({ lastActivityAt: at(0), cart: cartWith(54000) });
    t = T0 + 36 * MINUTE;
    const summary = await sweep();
    await sweep();

    assert.equal(summary.abandoned, 1);
    const closed = await reload(session);
    assert.equal(closed.status, 'abandoned');
    assert.equal(closed.isOpen, false);
    const events = await eventsOf(session, 'cart_abandoned');
    assert.equal(events.length, 1);
    assert.equal(events[0].data.totalPaise, 54000);
    assert.equal(events[0].at.getTime(), t);
  });

  test('36 min with an empty cart → ended, no event; a missed idle tick is skipped', async () => {
    const session = await makeSession({ lastActivityAt: at(0) });
    t = T0 + 36 * MINUTE;
    const summary = await sweep();
    assert.equal(summary.ended, 1);
    assert.equal(summary.idled, 0);
    const closed = await reload(session);
    assert.equal(closed.status, 'ended');
    assert.equal(closed.isOpen, false);
    assert.equal((await eventsOf(session)).length, 0);
  });

  test('an idle session also closes at 30 min', async () => {
    const session = await makeSession({ lastActivityAt: at(0), status: 'idle', cart: cartWith() });
    t = T0 + 31 * MINUTE;
    assert.equal((await sweep()).abandoned, 1);
    assert.equal((await reload(session)).status, 'abandoned');
  });

  test('checkout started 11 min ago → exactly one checkout_left across 3 sweeps; a later attempt can leave again', async () => {
    const customer = await makeCustomer();
    const restaurantId = new ObjectId();
    const req = { user: { _id: customer._id, role: 'customer', name: customer.name } };

    await activity.record(req, restaurantId, 'checkout_started');
    const session = await CustomerSession.findOne({ userId: customer._id }).lean();
    assert.equal(session.checkoutStartedAt.getTime(), T0);

    // Still browsing, so the session stays active while checkout goes unfinished.
    t = T0 + 8 * MINUTE;
    await activity.record(req, restaurantId, 'menu_searched', { query: 'naan' });
    t = T0 + 11 * MINUTE;
    for (let i = 0; i < 3; i += 1) await sweep();

    let current = await reload(session);
    assert.equal((await eventsOf(session, 'checkout_left')).length, 1);
    assert.equal(current.checkoutStartedAt, null);
    assert.equal(current.checkoutLeftAt.getTime(), T0 + 11 * MINUTE);
    assert.equal(current.status, 'active');

    // A second attempt: checkout_started clears checkoutLeftAt and sets a new start.
    t = T0 + 12 * MINUTE;
    await activity.record(req, restaurantId, 'checkout_started');
    current = await reload(session);
    assert.equal(current.checkoutLeftAt, null);
    assert.equal(current.checkoutStartedAt.getTime(), T0 + 12 * MINUTE);

    t = T0 + 23 * MINUTE;
    await sweep();
    await sweep();
    assert.equal((await eventsOf(session, 'checkout_left')).length, 2);
  });

  test('converted, ended and abandoned sessions are never touched', async () => {
    const closed = await Promise.all(
      ['converted', 'ended', 'abandoned'].map((status) =>
        makeSession({ status, lastActivityAt: at(0), cart: cartWith(), checkoutStartedAt: at(0) })
      )
    );
    const beforeRows = await Promise.all(closed.map(reload));
    t = T0 + 2 * 60 * MINUTE;
    const summary = await sweep();

    assert.deepEqual(summary, { idled: 0, abandoned: 0, ended: 0, checkoutLeft: 0, expired: 0, scanned: 0 });
    assert.deepEqual(await Promise.all(closed.map(reload)), beforeRows);
    assert.equal(await ActivityEvent.countDocuments(), 0);
  });

  test('a new event on an idle session makes it active again', async () => {
    const customer = await makeCustomer();
    const restaurantId = new ObjectId();
    const req = { user: { _id: customer._id, role: 'customer', name: customer.name } };
    await activity.record(req, restaurantId, 'restaurant_viewed');
    t = T0 + 6 * MINUTE;
    await sweep();
    const session = await CustomerSession.findOne({ userId: customer._id }).lean();
    assert.equal(session.status, 'idle');

    t = T0 + 8 * MINUTE;
    await activity.record(req, restaurantId, 'menu_searched', { query: 'dal' });
    const again = await reload(session);
    assert.equal(again.status, 'active');
    assert.equal(again.isOpen, true);
    assert.equal(again.lastActivityAt.getTime(), T0 + 8 * MINUTE);
    assert.equal(await CustomerSession.countDocuments(), 1, 'the same session, not a new one');
  });
});

// ─── Safety ────────────────────────────────────────────────────────────────

describe('safety', () => {
  test('two concurrent sweeps make each transition and write each event once', async () => {
    const idle = await Promise.all([1, 2, 3].map(() => makeSession({ lastActivityAt: at(0) })));
    const abandoned = await Promise.all([1, 2, 3].map(() => makeSession({ lastActivityAt: at(-30 * MINUTE), cart: cartWith() })));
    const ended = await Promise.all([1, 2].map(() => makeSession({ lastActivityAt: at(-30 * MINUTE) })));
    const checkout = await makeSession({ lastActivityAt: at(5 * MINUTE), checkoutStartedAt: at(-5 * MINUTE) });
    t = T0 + 6 * MINUTE;

    const [a, b] = await Promise.all([sweep(), sweep()]);
    const total = (key) => a[key] + b[key];
    assert.equal(total('idled'), 3);
    assert.equal(total('abandoned'), 3);
    assert.equal(total('ended'), 2);
    assert.equal(total('checkoutLeft'), 1);

    assert.equal(await ActivityEvent.countDocuments({ type: 'went_idle' }), 3);
    assert.equal(await ActivityEvent.countDocuments({ type: 'cart_abandoned' }), 3);
    assert.equal(await ActivityEvent.countDocuments({ type: 'checkout_left' }), 1);
    for (const s of [...idle, ...abandoned, checkout]) assert.equal((await reload(s)).eventCount, 1);
    for (const s of ended) assert.equal((await reload(s)).eventCount, 0);
  });

  test('a customer event landing between the read and the write wins', async () => {
    const customer = await makeCustomer();
    const restaurantId = new ObjectId();
    const req = { user: { _id: customer._id, role: 'customer', name: customer.name } };
    await activity.record(req, restaurantId, 'restaurant_viewed');
    await CustomerSession.updateOne({ userId: customer._id }, { $set: { cart: cartWith() } });

    // What a sweeper read 31 min later…
    t = T0 + 31 * MINUTE;
    const read = await CustomerSession.findOne({ userId: customer._id }).lean();
    // …then the customer acts before the sweeper writes. (record() would itself treat a
    // 31-min-old session as timed out, so the fresh activity is written as A2's update does.)
    await CustomerSession.updateOne(
      { _id: read._id },
      { $set: { lastActivityAt: clock.now(), lastEvent: { type: 'item_viewed', label: 'Viewed Naan', at: clock.now() } } }
    );

    assert.equal(await activity.closeTimedOutSession(read, clock.now()), null);
    assert.equal(await activity.idleSession(read, clock.now()), false);
    const stillOpen = await reload(read);
    assert.equal(stillOpen.status, 'active');
    assert.equal(stillOpen.lastEvent.type, 'item_viewed');
    assert.equal(await ActivityEvent.countDocuments({ type: { $in: ['cart_abandoned', 'went_idle'] } }), 0);
  });

  test('600 stale sessions → 500 this tick (oldest first), the other 100 next tick', async () => {
    const docs = Array.from({ length: 600 }, (_, i) => ({
      restaurantId: new ObjectId(),
      userId: new ObjectId(),
      displayName: 'Guest',
      status: 'active',
      isOpen: true,
      startedAt: at(-60 * MINUTE + i),
      lastActivityAt: at(-60 * MINUTE + i),
      expiresAt: at(90 * 24 * 60 * MINUTE),
      cart: { items: [], totalPaise: 0, updatedAt: null },
    }));
    await CustomerSession.collection.insertMany(docs);

    const first = await sweep();
    assert.equal(first.scanned, 500);
    assert.equal(first.ended, 500);
    const stillOpen = await CustomerSession.find({ isOpen: true }).sort({ lastActivityAt: 1 }).lean();
    assert.equal(stillOpen.length, 100);
    assert.equal(stillOpen[0].lastActivityAt.getTime(), docs[500].lastActivityAt.getTime(), 'oldest went first');

    const second = await sweep();
    assert.equal(second.ended, 100);
    assert.equal(await CustomerSession.countDocuments({ isOpen: true }), 0);
  });

  test('the sweeper queries use an index (not a collection scan)', async () => {
    await makeSession({ lastActivityAt: at(0) });
    const plans = await Promise.all([
      CustomerSession.find({ status: { $in: live.OPEN_SESSION_STATUSES }, lastActivityAt: { $lte: at(0) } })
        .sort({ lastActivityAt: 1 })
        .explain('queryPlanner'),
      CustomerSession.find({ isOpen: true, checkoutStartedAt: { $lte: at(0) } })
        .sort({ checkoutStartedAt: 1 })
        .explain('queryPlanner'),
    ]);
    for (const plan of plans) {
      const text = JSON.stringify(plan[0]?.queryPlanner?.winningPlan ?? plan.queryPlanner.winningPlan);
      assert.match(text, /IXSCAN/);
      assert.doesNotMatch(text, /COLLSCAN/);
    }
  });

  test('runSessionSweep: nothing with the switch off; never two at once', async () => {
    await makeSession({ lastActivityAt: at(0) });
    t = T0 + 6 * MINUTE;

    live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
    assert.equal(await activity.runSessionSweep(), null);
    assert.equal(await ActivityEvent.countDocuments(), 0);

    live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
    const [first, second] = await Promise.all([activity.runSessionSweep(), activity.runSessionSweep()]);
    assert.equal(first.idled, 1);
    assert.equal(second, null, 'the overlapping tick is skipped');
    assert.equal((await activity.runSessionSweep()).idled, 0, 'runs again once the first finished');
  });
});

// ─── Read scope + row shape ────────────────────────────────────────────────

test('liveSessionScope hides opted-out customers\' sessions', async () => {
  const restaurantId = new ObjectId();
  await makeSession({ restaurantId });
  await makeSession({ restaurantId, hiddenAt: at(0), status: 'ended' });
  await makeSession();
  assert.deepEqual(activity.liveSessionScope(restaurantId), { restaurantId, hiddenAt: null });
  assert.equal(await CustomerSession.countDocuments(activity.liveSessionScope(restaurantId)), 1);
});

describe('toSessionRow', () => {
  const KEYS = [
    'cameFromSearch',
    'cart',
    'displayName',
    'eventCount',
    'id',
    'isGuest',
    'lastActivityAt',
    'lastEvent',
    'notEligibleReason',
    'offerEligible',
    'orderId',
    'pastOrderCount',
    'startedAt',
    'status',
  ];

  test('only the whitelisted keys — never the userId or anything else on the document', async () => {
    const session = await makeSession({
      cart: cartWith(54000),
      cameFromSearch: 'biryani',
      pastOrderCount: 3,
      lastEvent: { type: 'cart_item_added', label: 'Added Paneer Tikka ×2', at: at(0) },
      eventCount: 4,
      checkoutStartedAt: at(0),
      hiddenAt: null,
    });
    const row = toSessionRow(session.toObject());
    assert.deepEqual(Object.keys(row).sort(), KEYS);
    assert.deepEqual(Object.keys(row.cart).sort(), ['itemCount', 'items', 'totalPaise']);
    assert.deepEqual(Object.keys(row.cart.items[0]).sort(), ['name', 'qty']);
    assert.deepEqual(Object.keys(row.lastEvent).sort(), ['at', 'label', 'type']);
    assert.ok(!JSON.stringify(row).includes(String(session.userId)), 'no userId anywhere');

    assert.equal(row.id, String(session._id));
    assert.equal(row.cart.itemCount, 2);
    assert.equal(row.cart.totalPaise, 54000);
    assert.equal(row.cameFromSearch, 'biryani');
    assert.equal(row.lastEvent.at, at(0).toISOString());
    assert.equal(row.offerEligible, null);
    assert.equal(row.notEligibleReason, null);
  });

  test('eligibility comes from the caller (A4)', async () => {
    const session = (await makeSession()).toObject();
    assert.deepEqual(
      [toSessionRow(session, { offerEligibility: { eligible: true } })].map((r) => [r.offerEligible, r.notEligibleReason]),
      [[true, null]]
    );
    const guest = toSessionRow({ ...session, isGuest: true }, { offerEligibility: { eligible: false, reason: 'GUEST_NOT_ELIGIBLE' } });
    assert.equal(guest.offerEligible, false);
    assert.equal(guest.notEligibleReason, 'GUEST_NOT_ELIGIBLE');
  });

  test('a fresh session with no events or cart', async () => {
    const row = toSessionRow((await makeSession()).toObject());
    assert.equal(row.lastEvent, null);
    assert.deepEqual(row.cart, { itemCount: 0, totalPaise: 0, items: [] });
    assert.equal(row.orderId, null);
  });
});
