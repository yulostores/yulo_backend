// Live customer activity — AT: the whole feature end to end with the switch on, over the real
// HTTP API and real sockets. A customer browses and fills a cart; the owner sees the session
// (list + socket), previews and sends a 15% offer; the customer receives it, it is delivered,
// viewed, applied, shown at checkout and redeemed by an order; metrics count it; a second
// checkout with it fails; cancelling the order before acceptance gives it back.
//
// Every response and socket payload the frontends rely on is captured here and checked against
// the contract fixtures in yulo_backend/docs/live-fixtures/ (ids and dates normalised). A shape
// change fails the last test. After an intended change, regenerate them:
//   LIVE_FIXTURES_WRITE=1 npm test -- test/live-e2e.test.js

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as connect } from 'socket.io-client';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const activity = await import('../services/activity.service.js');
const { liveOfferLimiter, liveOfferLimiterKey } = await import('../middleware/rateLimiter.js');
const { generateTokens } = await import('../services/auth.service.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: Order } = await import('../models/Order.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: User } = await import('../models/User.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');
const { makeDeliveryCustomer, makeGuest, makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

const FIXTURE_DIR = fileURLToPath(new URL('../../docs/live-fixtures/', import.meta.url));
const WRITE = process.env.LIVE_FIXTURES_WRITE === '1';

let mongo;
let srv;
const sockets = [];
const captured = new Map(); // fixture name → normalised payload

// ─── Fixture capture ───────────────────────────────────────────────────────

/** Ids → "<id>", ISO dates → "<date>" so fixtures are stable across runs. */
const normalise = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replace(/"[a-f\d]{24}"/g, '"<id>"')
      .replace(/"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z"/g, '"<date>"')
  );
const capture = (name, value) => captured.set(name, normalise(value));

/** The shape of a value: key names and types, arrays by their first element. */
const shapeOf = (value) => {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
  }
  return typeof value;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const call = async (method, url, user, body, headers = {}) => {
  const res = await srv.request(method, url, { headers: { ...(user ? { authorization: `Bearer ${bearer(user)}` } : {}), ...headers }, body });
  await activity.__flushForTests();
  return res;
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
};
const bearer = (user) => generateTokens(user._id, user.role).accessToken;

const open = () =>
  new Promise((resolve, reject) => {
    const socket = connect(srv.base, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    socket.received = [];
    socket.onAny((event, payload) => socket.received.push({ event, payload }));
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
const ask = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const waitFor = async (socket, name, match = () => true) => {
  const deadline = Date.now() + 2000;
  for (;;) {
    const hit = socket.received.find((r) => r.event === name && match(r.payload));
    if (hit) return hit.payload;
    if (Date.now() > deadline) throw new Error(`no ${name} within 2 s; got ${socket.received.map((r) => r.event)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CustomerSession.init(), ActivityEvent.init(), Discount.init(), IdempotencyKey.init()]);
  srv = await startTestServer({ withSocket: true });
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
});

after(async () => {
  live.__setLiveActivityForTests(null);
  for (const socket of sockets) socket.close();
  await srv?.close();
  await mongo?.stop();
});

// ─── The journey ───────────────────────────────────────────────────────────

test('browse → cart → offer → delivered → viewed → applied → redeemed → metrics → reuse refused → cancel returns it', async () => {
  const { restaurant, owner, paneer, naan } = await makeRestaurant({ name: 'Spice Route' });
  const customer = await makeDeliveryCustomer({ name: 'Meera Nair' });
  const admin = await User.create({ name: 'Admin', email: 'admin@e2e.local', role: 'admin' });
  ok(await call('POST', '/api/admin/finance/settings', admin, { settings: { codEnabled: true }, note: 'COD for e2e' }), 201);
  const rid = String(restaurant._id);
  const owners = `/api/owner/${rid}/live`;

  // Sockets: the owner's dashboard and the customer's app.
  const ownerSocket = await open();
  const ownerAck = await ask(ownerSocket, 'join_restaurant', { restaurantId: rid, token: bearer(owner) });
  const customerSocket = await open();
  const customerAck = await ask(customerSocket, 'join_user', { token: bearer(customer) });
  const guestSocket = await open();
  const guestAck = await ask(guestSocket, 'join_user', { token: bearer(await makeGuest()) });
  assert.deepEqual([ownerAck, customerAck, guestAck], [{ ok: true }, { ok: true }, { ok: false, code: 'GUEST' }]);
  capture('socket-acks', { join_restaurant: ownerAck, join_user: customerAck, join_user_refused: guestAck });

  // 1. The customer browses and adds two items.
  ok(await call('GET', `/api/restaurants/${rid}`, customer));
  ok(await call('GET', `/api/restaurants/${rid}/menu`, customer));
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 2 }), 201);
  const cart = ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(naan._id), qty: 1 }), 201).data;
  const cartTotal = cart.bill.charges.grandTotal;

  // 2. The owner sees the session with the cart, over HTTP and the socket.
  const list = ok(await call('GET', `${owners}/sessions`, owner));
  capture('owner-sessions-list', list);
  const [row] = list.data.sessions;
  assert.equal(list.data.sessions.length, 1);
  assert.equal(row.displayName, 'Meera');
  assert.equal(row.cart.totalPaise, cartTotal);
  assert.equal(row.cart.itemCount, 3);
  assert.equal(row.offerEligible, true);
  assert.deepEqual(list.data.summary, { live: 1, cartsInProgress: 1, cartsTotalPaise: cartTotal, abandonedLastHour: 0 });
  const pushedRow = await waitFor(ownerSocket, 'session_updated', (p) => p.cart.itemCount === 3);
  assert.equal(pushedRow.id, row.id);
  capture('socket-session_updated', pushedRow);
  capture('socket-activity_event', await waitFor(ownerSocket, 'activity_event', (p) => p.type === 'cart_item_added'));
  const sessionId = row.id;
  capture('owner-session-detail', ok(await call('GET', `${owners}/sessions/${sessionId}`, owner)));
  capture('owner-session-events', ok(await call('GET', `${owners}/sessions/${sessionId}/events?limit=3`, owner)));

  // 3. Preview, then send, a 15% offer capped at ₹100.
  const terms = { sessionId, title: 'A treat for you', type: 'percentage', percentage: 15, maxDiscountAmount: 100, expiresInMinutes: 30 };
  await liveOfferLimiter.resetKey(liveOfferLimiterKey(rid));
  const preview = ok(await call('POST', `${owners}/offers`, owner, { ...terms, preview: true }));
  capture('owner-offer-preview', preview);
  // 15% of ₹540 = ₹81, under the cap.
  assert.deepEqual(preview.data, { wouldSavePaise: 8100, cartTotalPaise: 54000, eligibleSubtotalPaise: 54000 });
  assert.equal(await Discount.countDocuments(), 0, 'a preview saves nothing');
  const sent = ok(await call('POST', `${owners}/offers`, owner, terms), 201);
  capture('owner-offer-created', sent);
  const offerId = sent.data.offer.id;
  capture('socket-offer_updated', await waitFor(ownerSocket, 'offer_updated', (p) => p.offerStatus === 'sent'));

  // 4. The customer receives it, fetches it (delivered), opens it (viewed), applies it.
  const received = await waitFor(customerSocket, 'offer_received');
  assert.equal(received.offerId, offerId);
  assert.equal(received.restaurant.name, 'Spice Route');
  capture('socket-offer_received', received);
  const mine = ok(await call('GET', '/api/offers/mine', customer));
  capture('customer-offers-mine', mine);
  assert.equal(mine.data.offers[0].status, 'delivered');
  capture('customer-offer-viewed', ok(await call('POST', `/api/offers/${offerId}/viewed`, customer)));
  const applied = ok(await call('POST', '/api/cart/apply-offer', customer, { offerId }));
  capture('customer-cart-apply-offer', applied);
  assert.equal(applied.data.bill.charges.food.discount, 8100);
  capture('customer-cart-remove-offer', ok(await call('DELETE', '/api/cart/offer', customer)));
  ok(await call('POST', '/api/cart/apply-offer', customer, { offerId }));
  assert.equal((await Discount.findById(offerId).lean()).offerStatus, 'applied');

  // 5. Checkout shows it; the order takes it.
  const summary = ok(await call('GET', '/api/checkout/summary', customer));
  assert.equal(summary.data.bill.charges.food.discount, 8100);
  const placed = ok(
    await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod', expectedTotalPaise: summary.data.bill.charges.grandTotal }, { 'Idempotency-Key': 'e2e-1' }),
    201
  ).data;
  const order = await Order.findById(placed.orderId).lean();
  assert.equal(String(order.appliedDiscountId), offerId);
  assert.equal(order.charges.food.discount, 8100);
  const redeemed = await Discount.findById(offerId).lean();
  assert.equal(redeemed.offerStatus, 'redeemed');
  assert.equal(String(redeemed.orderId), String(placed.orderId));
  const converted = await CustomerSession.findById(sessionId).lean();
  assert.equal(converted.status, 'converted');
  assert.equal(String(converted.orderId), String(placed.orderId));
  await waitFor(ownerSocket, 'offer_updated', (p) => p.offerStatus === 'redeemed' && p.orderId === String(placed.orderId));
  capture('socket-offer_updated-customer', await waitFor(customerSocket, 'offer_updated', (p) => p.offerStatus === 'redeemed'));

  // 6. Metrics and the offer history count it.
  const metrics = ok(await call('GET', `${owners}/metrics?range=today`, owner));
  capture('owner-metrics', metrics);
  assert.equal(metrics.data.sent, 1);
  assert.equal(metrics.data.redeemed, 1);
  assert.equal(metrics.data.conversionRate, 1);
  assert.equal(metrics.data.revenuePaise, order.charges.grandTotal);
  assert.equal(metrics.data.discountPaise, 8100);
  const history = ok(await call('GET', `${owners}/offers`, owner));
  capture('owner-offers-list', history);
  assert.equal(history.data.offers[0].orderTotalPaise, order.charges.grandTotal);

  // 7. A second checkout with the same offer (a second device's cart still holds it) fails.
  ok(await call('POST', '/api/cart/items', customer, { menuItemId: String(paneer._id), qty: 2 }), 201);
  await Cart.updateOne({ userId: customer._id }, { $set: { appliedDiscountId: offerId } });
  const reuse = await call('POST', '/api/orders/checkout', customer, { paymentMethod: 'cod' });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.code, 'OFFER_ALREADY_USED');
  assert.equal(await Order.countDocuments(), 1);
  capture('error-offer-already-used', reuse.body);
  const reapply = await call('POST', '/api/cart/apply-offer', customer, { offerId });
  capture('error-apply-offer', reapply.body);

  // 8. The cart shows why the offer stopped applying.
  const cartNow = ok(await call('GET', '/api/cart', customer));
  assert.equal(cartNow.data.bill.offerIssue, 'OFFER_ALREADY_USED');
  capture('customer-cart-offer-issue', cartNow);

  // 9. Cancelling at `placed` gives the offer back (any pre-acceptance cancellation).
  ok(await call('POST', `/api/orders/${placed.orderId}/cancel`, customer, {}));
  const back = await Discount.findById(offerId).lean();
  assert.equal(back.offerStatus, 'viewed');
  assert.equal(back.isOpen, true);
  assert.equal(back.redemptionCount, 0);
  await waitFor(customerSocket, 'offer_updated', (p) => p.offerStatus === 'viewed');

  // 10. The owner revokes it; the customer opts out and the session leaves the dashboard.
  capture('owner-offer-revoked', ok(await call('POST', `${owners}/offers/${offerId}/revoke`, owner)));
  ok(await call('GET', `/api/restaurants/${rid}`, customer)); // a fresh session after conversion
  ok(await call('PATCH', '/api/users/me/preferences', customer, { shareActivity: false }));
  capture('socket-session_removed', await waitFor(ownerSocket, 'session_removed'));
});

// ─── Contract fixtures ─────────────────────────────────────────────────────

test('contract fixtures: every captured payload matches its fixture\'s shape', () => {
  assert.ok(captured.size >= 20, `captured ${captured.size}`);
  if (WRITE) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, value] of captured) {
      fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    }
  }
  const drift = [];
  for (const [name, value] of captured) {
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) {
      drift.push(`${name}: no fixture (run with LIVE_FIXTURES_WRITE=1)`);
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    try {
      assert.deepEqual(shapeOf(value), shapeOf(expected));
    } catch {
      drift.push(`${name}: shape changed`);
    }
  }
  assert.deepEqual(drift, []);
});
