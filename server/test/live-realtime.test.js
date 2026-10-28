// Live customer activity — A6: real-time. Owners (owner:<id>) get activity_event /
// session_updated / session_removed / offer_updated; waiters (restaurant:<id>) and other
// restaurants get none of it; customers (user:<id>, join_user) get their own offer_received /
// offer_updated; offer_ack delivers once; the switch off means no emits; and no payload ever
// carries a personal field. Real HTTP server on a random port, real socket.io-client sockets,
// in-memory MongoDB.

import test, { after, afterEach, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const liveEmit = await import('../services/liveEmit.service.js');
const { liveOfferLimiter, liveOfferLimiterKey } = await import('../middleware/rateLimiter.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { generateTokens, generateStaffToken } = await import('../services/auth.service.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: User } = await import('../models/User.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');
const { ObjectId, authHeader, makeCustomer, makeDeliveryCustomer, makeGuest, makeRestaurant, makeSession } = await import(
  '../test-utils/liveFixtures.mjs'
);

const MINUTE = 60 * 1000;
const LIVE_EVENTS = ['activity_event', 'session_updated', 'session_removed', 'offer_updated', 'offer_received'];
const SESSION_ROW_KEYS = [
  'cameFromSearch', 'cart', 'displayName', 'eventCount', 'id', 'isGuest', 'lastActivityAt', 'lastEvent',
  'notEligibleReason', 'offerEligible', 'orderId', 'pastOrderCount', 'startedAt', 'status',
];

let mongo;
let srv;
let t;
let sockets = [];
const emitted = []; // emits since the last reset (per action)
const allEmitted = []; // every emit in this file, for the PII scan

// ─── Socket helpers ────────────────────────────────────────────────────────

const open = () =>
  new Promise((resolve, reject) => {
    const socket = connect(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    socket.received = [];
    socket.onAny((event, payload) => socket.received.push({ event, payload }));
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });

const ask = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
    socket.emit(event, payload, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });

const disconnected = (socket) =>
  new Promise((resolve) => {
    if (!socket.connected) return resolve();
    socket.once('disconnect', () => resolve());
  });

/** Resolves with the first event `name` (matching `match`) the socket gets, within 2 s. */
const waitFor = async (socket, name, match = () => true) => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const hit = socket.received.find((r) => r.event === name && match(r.payload));
    if (hit) return hit.payload;
    if (Date.now() > deadline) throw new Error(`no ${name} within 2 s; got ${socket.received.map((r) => r.event)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const settle = async () => {
  await activity.__flushForTests();
  await new Promise((r) => setTimeout(r, 150));
};
const liveEventsOf = (socket) => socket.received.filter((r) => LIVE_EVENTS.includes(r.event));
// Emits to restaurants' owners (customer-room emits are checked on the customer's socket).
const count = (event, match = () => true) =>
  emitted.filter((e) => e.room.startsWith('owner:') && e.event === event && match(e.payload)).length;

const bearer = (user) => generateTokens(user._id, user.role).accessToken;
const joinOwner = (socket, restaurant, owner) =>
  ask(socket, 'join_restaurant', { restaurantId: String(restaurant._id), token: bearer(owner) });

const call = async (method, path, user, body) => {
  const res = await srv.request(method, path, { headers: user ? authHeader(user) : {}, body });
  await activity.__flushForTests();
  return res;
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};

const sendOffer = async (owner, restaurant, session, overrides = {}) => {
  await liveOfferLimiter.resetKey(liveOfferLimiterKey(String(restaurant._id)));
  return call('POST', `/api/owner/${restaurant._id}/live/offers`, owner, {
    sessionId: String(session._id),
    title: 'Come back treat',
    type: 'percentage',
    percentage: 10,
    maxDiscountAmount: 100,
    expiresInMinutes: 30,
    ...overrides,
  });
};

/** A customer with an open session at the restaurant (by browsing it). */
const browsingCustomer = async (restaurant, make = makeCustomer) => {
  const customer = await make();
  ok(await call('GET', `/api/restaurants/${restaurant._id}`, customer));
  const session = await CustomerSession.findOne({ userId: customer._id, restaurantId: restaurant._id }).lean();
  return { customer, session };
};

// ─── Lifecycle ─────────────────────────────────────────────────────────────

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CustomerSession.init(), ActivityEvent.init(), Discount.init(), IdempotencyKey.init()]);
  srv = await startTestServer({ withSocket: true });
  liveEmit.__onEmitForTests((room, event, payload) => {
    emitted.push({ room, event, payload });
    allEmitted.push({ room, event, payload });
  });
});

after(async () => {
  liveEmit.__onEmitForTests(null);
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  for (const socket of sockets) socket.close();
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  t = Date.now();
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
  activity.__resetWindowsForTests();
  emitted.length = 0;
});

afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

// ─── Owners, waiters, other restaurants ────────────────────────────────────

describe('owner room', () => {
  test('owner of A gets activity_event + session_updated; a waiter of A and the owner of B get nothing', async () => {
    const a = await makeRestaurant({ name: 'A' });
    const b = await makeRestaurant({ name: 'B' });
    const waiter = await StaffMember.create({ restaurantId: a.restaurant._id, staffCode: 'W01', name: 'Waiter', role: 'waiter', phone: '9000000002' });

    const ownerA = await open();
    const ownerB = await open();
    const waiterA = await open();
    assert.deepEqual(await joinOwner(ownerA, a.restaurant, a.owner), { ok: true });
    assert.deepEqual(await joinOwner(ownerB, b.restaurant, b.owner), { ok: true });
    waiterA.emit('join_waiter', { restaurantId: String(a.restaurant._id), staffToken: generateStaffToken(waiter._id, 'waiter', a.restaurant._id, 0) });
    await settle();
    assert.ok(waiterA.connected, 'the waiter joined');

    const { customer, session } = await browsingCustomer(a.restaurant);
    const event = await waitFor(ownerA, 'activity_event');
    assert.equal(event.sessionId, String(session._id));
    assert.equal(event.type, 'restaurant_viewed');
    assert.equal(event.label, 'Viewed menu');
    const row = await waitFor(ownerA, 'session_updated');
    assert.deepEqual(Object.keys(row).sort(), SESSION_ROW_KEYS);
    assert.equal(row.id, String(session._id));
    assert.equal(row.offerEligible, true);

    // The waiter is in restaurant:<A>; an offer and an opt-out go out as well, to be sure.
    ok(await sendOffer(a.owner, a.restaurant, session), 201);
    await waitFor(ownerA, 'offer_updated');
    ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
    await waitFor(ownerA, 'session_removed');
    await settle();
    assert.deepEqual(liveEventsOf(waiterA), [], 'nothing reaches staff devices');
    assert.deepEqual(liveEventsOf(ownerB), []);
    assert.ok(emitted.every((e) => e.room === `owner:${a.restaurant._id}` || e.room.startsWith('user:')), 'never restaurant:<id>');
  });

  test('the owner of B can\'t join A\'s room; a bad token is refused — both acked, then disconnected', async () => {
    const a = await makeRestaurant({ name: 'A' });
    const b = await makeRestaurant({ name: 'B' });
    const intruder = await open();
    assert.deepEqual(await joinOwner(intruder, a.restaurant, b.owner), { ok: false, code: 'FORBIDDEN' });
    await disconnected(intruder);

    const garbage = await open();
    assert.deepEqual(await ask(garbage, 'join_restaurant', { restaurantId: String(a.restaurant._id), token: 'nope' }), { ok: false, code: 'UNAUTHORIZED' });
    await disconnected(garbage);

    const customerToken = await open();
    const customer = await makeCustomer();
    assert.deepEqual(await ask(customerToken, 'join_restaurant', { restaurantId: String(a.restaurant._id), token: bearer(customer) }), { ok: false, code: 'UNAUTHORIZED' });
    await disconnected(customerToken);
  });

  test('join_restaurant without a callback (an older portal) still joins and receives', async () => {
    const a = await makeRestaurant();
    const owner = await open();
    owner.emit('join_restaurant', { restaurantId: String(a.restaurant._id), token: bearer(a.owner) });
    await settle();
    await browsingCustomer(a.restaurant);
    await waitFor(owner, 'activity_event');
  });
});

// ─── One update per change ─────────────────────────────────────────────────

describe('one emit per change', () => {
  test('a sweep tick: one session_updated per changed session, one activity_event per event', async () => {
    const a = await makeRestaurant();
    const owner = await open();
    await joinOwner(owner, a.restaurant, a.owner);
    const rid = a.restaurant._id;
    const cart = { items: [{ menuItemId: new ObjectId(), name: 'Paneer Tikka', qty: 1, unitPricePaise: 25000 }], totalPaise: 25000 };
    const idle = await makeSession({ restaurantId: rid, lastActivityAt: new Date(t - 6 * MINUTE) });
    const abandoned = await makeSession({ restaurantId: rid, lastActivityAt: new Date(t - 31 * MINUTE), cart });
    // Its offer lapses in the same tick: still one session_updated for it, not one per change.
    await Discount.create({
      restaurantId: rid, offerName: 'Lapsed', type: 'percentage', percentage: 10, maxDiscountAmount: 100,
      kind: 'personal', targetUserId: abandoned.userId, sessionId: abandoned._id, offerStatus: 'sent',
      isOpen: true, status: 'active', applicableTo: 'delivery', startDate: new Date(t - 40 * MINUTE), endDate: new Date(t - MINUTE),
    });
    // Two transitions in one tick (idle, then checkout_left) — still one session_updated.
    const both = await makeSession({ restaurantId: rid, lastActivityAt: new Date(t - 6 * MINUTE), checkoutStartedAt: new Date(t - 11 * MINUTE) });
    emitted.length = 0;

    const summary = await activity.sweepSessions(clock.now());
    assert.deepEqual([summary.idled, summary.abandoned, summary.checkoutLeft, summary.expired], [2, 1, 1, 1]);
    assert.equal(count('offer_updated', (p) => p.offerStatus === 'expired' && p.sessionId === String(abandoned._id)), 1);
    for (const s of [idle, abandoned, both]) {
      assert.equal(count('session_updated', (p) => p.id === String(s._id)), 1, `one row for ${s._id}`);
    }
    assert.equal(count('activity_event', (p) => p.type === 'went_idle'), 2);
    assert.equal(count('activity_event', (p) => p.type === 'cart_abandoned'), 1);
    assert.equal(count('activity_event', (p) => p.type === 'checkout_left'), 1);
    const row = await waitFor(owner, 'session_updated', (p) => p.id === String(abandoned._id));
    assert.equal(row.status, 'abandoned');
    assert.equal(row.notEligibleReason, 'SESSION_CLOSED');

    emitted.length = 0;
    await activity.sweepSessions(clock.now());
    assert.equal(count('session_updated'), 0, 'nothing changed, nothing sent');
  });

  test('offer sent, revoked, expired and redeemed: one offer_updated each (and one session_updated for sent/revoked)', async () => {
    const a = await makeRestaurant();
    const owner = await open();
    await joinOwner(owner, a.restaurant, a.owner);
    const { customer, session } = await browsingCustomer(a.restaurant, makeDeliveryCustomer);
    const forSession = (p) => p.id === String(session._id);

    emitted.length = 0;
    const sent = ok(await sendOffer(a.owner, a.restaurant, session), 201).offer;
    assert.equal(count('offer_updated', (p) => p.offerId === sent.id && p.offerStatus === 'sent'), 1);
    assert.equal(count('session_updated', forSession), 1);
    assert.equal(count('activity_event', (p) => p.type === 'offer_sent'), 1);
    assert.equal((await waitFor(owner, 'session_updated', (p) => forSession(p) && p.notEligibleReason === 'OFFER_OPEN')).offerEligible, false);

    emitted.length = 0;
    ok(await call('POST', `/api/owner/${a.restaurant._id}/live/offers/${sent.id}/revoke`, a.owner));
    assert.equal(count('offer_updated', (p) => p.offerId === sent.id && p.offerStatus === 'revoked'), 1);
    assert.equal(count('session_updated', forSession), 1);

    // Expired by the sweep.
    const lapsing = ok(await sendOffer(a.owner, a.restaurant, session, { expiresInMinutes: 10 }), 201).offer;
    t += 11 * MINUTE;
    await call('GET', `/api/restaurants/${a.restaurant._id}`, customer); // keep the session open
    emitted.length = 0;
    await activity.sweepSessions(clock.now());
    assert.equal(count('offer_updated', (p) => p.offerId === lapsing.id && p.offerStatus === 'expired'), 1);

    // Redeemed at checkout.
    await Discount.updateMany({}, { $set: { isOpen: false } });
    const admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
    ok(await call('POST', '/api/admin/finance/settings', admin, { settings: { codEnabled: true }, note: 'COD' }), 201);
    const redeemable = ok(await sendOffer(a.owner, a.restaurant, session), 201).offer;
    ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(a.paneer._id), qty: 2 }), 201);
    ok(await call('POST', '/api/cart/apply-offer', customer, { offerId: redeemable.id }));
    emitted.length = 0;
    ok(await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod' }), 201);
    await settle();
    assert.equal(count('offer_updated', (p) => p.offerId === redeemable.id && p.offerStatus === 'redeemed' && p.orderId), 1);
    assert.equal(
      emitted.filter((e) => e.room === `user:${customer._id}` && e.event === 'offer_updated' && e.payload.offerStatus === 'redeemed').length,
      1,
      'and one to the customer'
    );
  });

  test('opting out sends session_removed for each of the customer\'s sessions', async () => {
    const a = await makeRestaurant({ name: 'A' });
    const b = await makeRestaurant({ name: 'B' });
    const ownerA = await open();
    const ownerB = await open();
    await joinOwner(ownerA, a.restaurant, a.owner);
    await joinOwner(ownerB, b.restaurant, b.owner);
    const { customer, session } = await browsingCustomer(a.restaurant);
    ok(await call('GET', `/api/restaurants/${b.restaurant._id}`, customer));
    const atB = await CustomerSession.findOne({ userId: customer._id, restaurantId: b.restaurant._id }).lean();

    ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
    assert.deepEqual(await waitFor(ownerA, 'session_removed'), { sessionId: String(session._id) });
    assert.deepEqual(await waitFor(ownerB, 'session_removed'), { sessionId: String(atB._id) });
  });
});

// ─── Customer channel ──────────────────────────────────────────────────────

describe('customer channel', () => {
  test('join_user: own offers only; the payload userId is ignored; guest and garbage tokens refused', async () => {
    const a = await makeRestaurant({ name: 'Spice Route' });
    const one = await browsingCustomer(a.restaurant);
    const two = await browsingCustomer(a.restaurant);

    const mine = await open();
    // Claims to be customer two — the room comes from the token (customer one).
    assert.deepEqual(await ask(mine, 'join_user', { token: bearer(one.customer), userId: String(two.customer._id) }), { ok: true });
    const theirs = await open();
    assert.deepEqual(await ask(theirs, 'join_user', { token: bearer(two.customer) }), { ok: true });

    const offer = ok(await sendOffer(a.owner, a.restaurant, one.session, { applicableItems: [String(a.paneer._id)] }), 201).offer;
    const received = await waitFor(mine, 'offer_received');
    assert.deepEqual(received, {
      offerId: offer.id,
      restaurant: { id: String(a.restaurant._id), name: 'Spice Route' },
      title: 'Come back treat',
      type: 'percentage',
      percentage: 10,
      flatAmount: null,
      maxDiscountAmount: 100,
      minimumOrderValue: 0,
      applicableItems: ['Paneer Tikka'],
      endDate: new Date(t + 30 * MINUTE).toISOString(),
    });
    await settle();
    assert.deepEqual(liveEventsOf(theirs), [], 'another customer gets nothing');

    ok(await call('POST', `/api/owner/${a.restaurant._id}/live/offers/${offer.id}/revoke`, a.owner));
    const update = await waitFor(mine, 'offer_updated');
    assert.equal(update.offerStatus, 'revoked');
    assert.ok(!('sessionId' in update), 'the customer is not told about sessions');

    const guestSocket = await open();
    assert.deepEqual(await ask(guestSocket, 'join_user', { token: bearer(await makeGuest()) }), { ok: false, code: 'GUEST' });
    await disconnected(guestSocket);
    const garbage = await open();
    assert.deepEqual(await ask(garbage, 'join_user', { token: 'garbage' }), { ok: false, code: 'UNAUTHORIZED' });
    await disconnected(garbage);
    const ownerToken = await open();
    assert.deepEqual(await ask(ownerToken, 'join_user', { token: bearer(a.owner) }), { ok: false, code: 'UNAUTHORIZED' });
    await disconnected(ownerToken);
  });

  test('offer_ack: delivered once, the restaurant told once; acking someone else\'s offer does nothing', async () => {
    const a = await makeRestaurant();
    const owner = await open();
    await joinOwner(owner, a.restaurant, a.owner);
    const one = await browsingCustomer(a.restaurant);
    const two = await browsingCustomer(a.restaurant);
    const offer = ok(await sendOffer(a.owner, a.restaurant, one.session), 201).offer;

    const stranger = await open();
    await ask(stranger, 'join_user', { token: bearer(two.customer) });
    emitted.length = 0;
    assert.deepEqual(await ask(stranger, 'offer_ack', { offerId: offer.id }), { ok: true }, 'same answer — reveals nothing');
    assert.deepEqual(await ask(stranger, 'offer_ack', { offerId: String(new ObjectId()) }), { ok: true });
    assert.equal((await Discount.findById(offer.id).lean()).offerStatus, 'sent');
    assert.equal(count('offer_updated'), 0);

    const mine = await open();
    await ask(mine, 'join_user', { token: bearer(one.customer) });
    t += MINUTE;
    await ask(mine, 'offer_ack', { offerId: offer.id });
    t += MINUTE;
    await ask(mine, 'offer_ack', { offerId: offer.id });
    const stored = await Discount.findById(offer.id).lean();
    assert.equal(stored.offerStatus, 'delivered');
    assert.equal(stored.deliveredAt.getTime(), t - MINUTE, 'set once');
    assert.equal(count('offer_updated', (p) => p.offerId === offer.id && p.offerStatus === 'delivered'), 1);
    await waitFor(owner, 'offer_updated', (p) => p.offerStatus === 'delivered');

    // A socket that never joined as a customer can't ack anything.
    const anonymous = await open();
    const fresh = await Discount.create({ ...stored, _id: new ObjectId(), offerStatus: 'sent', isOpen: false });
    await ask(anonymous, 'offer_ack', { offerId: String(fresh._id) });
    assert.equal((await Discount.findById(fresh._id).lean()).offerStatus, 'sent');
  });
});

// ─── Switch off ────────────────────────────────────────────────────────────

test('switch off: no live emits at all, and join_user acks DISABLED', async () => {
  const a = await makeRestaurant();
  const owner = await open();
  await joinOwner(owner, a.restaurant, a.owner);
  const { customer, session } = await browsingCustomer(a.restaurant);

  live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
  emitted.length = 0;
  owner.received.length = 0;
  ok(await call('GET', `/api/restaurants/${a.restaurant._id}/menu`, customer));
  await CustomerSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date(t - 40 * MINUTE) } });
  await activity.runSessionSweep();
  ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
  await settle();
  assert.deepEqual(emitted, []);
  assert.deepEqual(liveEventsOf(owner), []);

  const customerSocket = await open();
  assert.deepEqual(await ask(customerSocket, 'join_user', { token: bearer(customer) }), { ok: false, code: 'DISABLED' });
  await disconnected(customerSocket);

  // A pilot that excludes this restaurant: on for others, silent for it.
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: String(new ObjectId()) });
  const other = await makeCustomer();
  ok(await call('GET', `/api/restaurants/${a.restaurant._id}`, other));
  await settle();
  assert.deepEqual(emitted, []);
});

// ─── No personal data ──────────────────────────────────────────────────────

describe('no personal data in any payload', () => {
  test('the guard drops deny-listed keys at any depth', () => {
    const cleaned = liveEmit.assertNoPii({
      sessionId: 'x',
      phone: '9999999999',
      nested: { Email: 'a@b.c', ok: 1, list: [{ address: 'street', lat: 1, lng: 2, label: 'fine' }] },
      card: '4111',
      upi: 'me@upi',
      token: 'secret',
      payment: {},
      location: {},
    });
    assert.deepEqual(cleaned, { sessionId: 'x', nested: { ok: 1, list: [{ label: 'fine' }] } });
  });

  test('a payload with a personal field is cleaned on its way out', async () => {
    const restaurantId = String(new ObjectId());
    emitted.length = 0;
    liveEmit.emitToOwners(restaurantId, 'activity_event', { sessionId: 's', data: { phone: '9876543210', itemName: 'Naan' } });
    liveEmit.emitToUser(String(new ObjectId()), 'offer_updated', { offerId: 'o', email: 'x@y.z' });
    assert.deepEqual(emitted.map((e) => e.payload), [{ sessionId: 's', data: { itemName: 'Naan' } }, { offerId: 'o' }]);
  });

  test('the emit helpers themselves refuse while the switch (or the pilot list) is off', () => {
    const restaurantId = String(new ObjectId());
    emitted.length = 0;
    live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
    liveEmit.emitToOwners(restaurantId, 'session_removed', { sessionId: 's' });
    liveEmit.emitToUser(String(new ObjectId()), 'offer_updated', { offerId: 'o' });
    live.__setLiveActivityForTests({ enabled: true, restaurantIds: String(new ObjectId()) });
    liveEmit.emitToOwners(restaurantId, 'session_removed', { sessionId: 's' });
    liveEmit.emitToUser(String(new ObjectId()), 'offer_updated', { offerId: 'o' }, { restaurantId });
    assert.deepEqual(emitted, []);
    live.__setLiveActivityForTests({ enabled: true, restaurantIds: restaurantId });
    liveEmit.emitToOwners(restaurantId, 'session_removed', { sessionId: 's' });
    assert.equal(emitted.length, 1);
  });

  test('every payload emitted in this file is free of deny-listed keys', () => {
    assert.ok(allEmitted.length > 20, `captured ${allEmitted.length} emits`);
    const deny = new Set(['phone', 'email', 'address', 'location', 'lat', 'lng', 'payment', 'card', 'upi', 'token']);
    const scan = (value, path) => {
      if (Array.isArray(value)) return value.forEach((v, i) => scan(v, `${path}[${i}]`));
      if (!value || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        assert.ok(!deny.has(key.toLowerCase()), `${path}.${key}`);
        scan(inner, `${path}.${key}`);
      }
    };
    for (const { event, payload } of allEmitted) scan(payload, event);
    // And no customer phone number anywhere, by value.
    assert.ok(!JSON.stringify(allEmitted).match(/"9\d{9}"/), 'no phone numbers');
  });
});
