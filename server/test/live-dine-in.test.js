// Live customer activity for diners at a table (yulo_menu's table QR): the diner token, table-
// tagged sessions, the synced phone cart, ordering rounds without ending the visit, waiter calls
// and bill views, offers the owner sends a diner (one per table) coming off the table's bill,
// redemption when the bill is paid, and the longer dine-in timeout.
// In-memory MongoDB, the real HTTP API and a fake clock.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const activity = await import('../services/activity.service.js');
const billingService = await import('../services/billing.service.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: User } = await import('../models/User.js');
const { authHeader, makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-10-27T10:00:00Z');

let mongo;
let srv;
let t;

const call = async (method, path, headers = {}, body) => {
  const res = await srv.request(method, path, { headers, body });
  await activity.__flushForTests();
  return res;
};
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** A restaurant (paneer ₹250, naan ₹40) with table T5, and helpers bound to it. */
const setup = async () => {
  const fixtures = await makeRestaurant();
  const table = await Table.create({ restaurantId: fixtures.restaurant._id, identifier: 'T5' });
  const base = `/api/restaurants/${fixtures.restaurant._id}`;
  const tableBase = `${base}/tables/${table._id}`;
  const diner = async () => ok(await call('POST', `${tableBase}/diner`), 201).token;
  const syncCart = (token, items) =>
    call('PUT', `${tableBase}/cart`, bearer(token), { items: items.map(([item, quantity]) => ({ menuItemId: String(item._id), quantity })) });
  const order = async (token, items) => {
    const data = ok(
      await call('POST', `${tableBase}/orders`, { ...bearer(token), 'Idempotency-Key': `k-${Math.random()}` }, {
        items: items.map(([item, quantity]) => ({ menuItemId: String(item._id), quantity })),
      }),
      201
    );
    // The restaurant accepts the round, so it is on the bill.
    await Order.updateOne({ _id: data.order._id }, { $set: { status: 'confirmed' } });
    return data;
  };
  const sendOffer = (sessionId, body = {}) =>
    call('POST', `/api/owner/${fixtures.restaurant._id}/live/offers`, authHeader(fixtures.owner), {
      sessionId: String(sessionId),
      title: 'Dessert on us',
      type: 'percentage',
      percentage: 10,
      maxDiscountAmount: 100,
      expiresInMinutes: 30,
      ...body,
    });
  const sessions = async () => ok(await call('GET', `/api/owner/${fixtures.restaurant._id}/live/sessions`, authHeader(fixtures.owner))).sessions;
  return { ...fixtures, table, base, tableBase, diner, syncCart, order, sendOffer, sessions };
};

const sessionOf = (token) => CustomerSession.findOne({ userId: JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).userId }).lean();
const eventTypes = async (session) => (await ActivityEvent.find({ sessionId: session._id }).sort({ at: 1, _id: 1 }).lean()).map((e) => e.type);

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Discount.init(), CustomerSession.init(), ActivityEvent.init()]);
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
  t = new Date(T0);
  clock.__setClockForTests(() => t);
  live.__setLiveActivityForTests({ enabled: true, restaurantIds: '' });
  activity.__setRedisForTests(null);
  activity.__resetWindowsForTests();
});

describe('diner token and table sessions', () => {
  test('no token while live activity is off for the restaurant — the menu works as before', async () => {
    const s = await setup();
    live.__setLiveActivityForTests({ enabled: false });
    assert.equal(ok(await call('POST', `${s.tableBase}/diner`)).token, null);
  });

  test('opening the menu with a diner token opens a dine-in session against the table', async () => {
    const s = await setup();
    const token = await s.diner();
    ok(await call('GET', `${s.base}/menu`, bearer(token)));
    const session = await sessionOf(token);
    assert.equal(session.channel, 'dine_in');
    assert.equal(session.table.number, 'T5');
    assert.equal(session.displayName, 'Guest');
    const [row] = await s.sessions();
    assert.equal(row.channel, 'dine_in');
    assert.equal(row.tableNumber, 'T5');
    assert.equal(row.offerEligible, true, 'a diner can be sent an offer even as a guest');
  });

  test('the phone cart is synced and priced by the server; each change is one event', async () => {
    const s = await setup();
    const token = await s.diner();
    assert.equal((await s.syncCart(token, [[s.paneer, 2]])).status, 202);
    await s.syncCart(token, [[s.paneer, 3], [s.naan, 1]]);
    await s.syncCart(token, [[s.naan, 1]]);
    const session = await sessionOf(token);
    assert.deepEqual(await eventTypes(session), ['cart_item_added', 'cart_qty_changed', 'cart_item_added', 'cart_item_removed']);
    assert.deepEqual(session.cart.items.map((l) => [l.name, l.qty, l.unitPricePaise]), [['Butter Naan', 1, 4000]]);
    assert.equal(session.cart.totalPaise, 4000);
    // Same cart again → nothing new.
    await s.syncCart(token, [[s.naan, 1]]);
    assert.equal((await eventTypes(session)).length, 4);
  });

  test('cart sync needs this table\'s diner token', async () => {
    const s = await setup();
    const other = await Table.create({ restaurantId: s.restaurant._id, identifier: 'T9' });
    const token = await s.diner();
    const res = await call('PUT', `${s.base}/tables/${other._id}/cart`, bearer(token), { items: [] });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'DINER_TOKEN_REQUIRED');
  });

  test('ordering a round keeps the visit open; waiter calls and bill views are recorded', async () => {
    const s = await setup();
    const token = await s.diner();
    await s.syncCart(token, [[s.paneer, 1]]);
    const { order } = await s.order(token, [[s.paneer, 1]]);
    ok(await call('POST', `${s.base}/requests`, bearer(token), { type: 'water', tableId: String(s.table._id) }), 201);
    ok(await call('GET', `${s.tableBase}/bill`, bearer(token)));
    const session = await sessionOf(token);
    assert.equal(session.status, 'active');
    assert.equal(String(session.orderId), String(order._id));
    assert.equal(session.cart.items.length, 0);
    assert.deepEqual(await eventTypes(session), ['cart_item_added', 'order_placed', 'waiter_called', 'bill_viewed']);
    assert.equal((await ActivityEvent.findOne({ type: 'waiter_called' }).lean()).label, 'Asked for water');
    const sitting = await TableSession.findOne({ tableId: s.table._id }).lean();
    assert.deepEqual(sitting.dinerIds.map(String), [String(session.userId)]);
  });

  test('the bill left open (polled every 15 s for 10 min) is one bill view; a return after a minute away is another', async () => {
    const s = await setup();
    const token = await s.diner();
    await s.order(token, [[s.paneer, 1]]);
    for (let i = 0; i < 40; i += 1) {
      ok(await call('GET', `${s.tableBase}/bill`, bearer(token)));
      t = new Date(t.getTime() + 15_000);
    }
    assert.equal(await ActivityEvent.countDocuments({ type: 'bill_viewed' }), 1);
    t = new Date(t.getTime() + 61_000);
    ok(await call('GET', `${s.tableBase}/bill`, bearer(token)));
    assert.equal(await ActivityEvent.countDocuments({ type: 'bill_viewed' }), 2);
  });
});

describe('offers to a diner', () => {
  test('the offer comes off the table bill and is redeemed when the bill is paid', async () => {
    const s = await setup();
    const token = await s.diner();
    await s.order(token, [[s.paneer, 2]]); // ₹500
    const session = await sessionOf(token);

    const preview = ok(await s.sendOffer(session._id, { preview: true }));
    assert.equal(preview.wouldSavePaise, 5000);
    const { offer } = ok(await s.sendOffer(session._id), 201);
    const stored = await Discount.findById(offer.id).lean();
    assert.equal(stored.applicableTo, 'dine_in');
    assert.equal(String(stored.tableId), String(s.table._id));

    // The diner's phone reads it (delivered) and opens it (viewed).
    const seen = ok(await call('GET', `${s.tableBase}/offer`, bearer(token))).offer;
    assert.equal(seen.id, offer.id);
    assert.equal(seen.status, 'delivered');
    ok(await call('POST', `${s.tableBase}/offer/${offer.id}/view`, bearer(token)));

    const { bill } = ok(await call('GET', `${s.tableBase}/bill`, bearer(token)));
    assert.equal(bill.discountTotal, 50);
    assert.equal((await Discount.findById(offer.id).lean()).offerStatus, 'applied');

    // A second round is re-priced into the offer.
    await s.order(token, [[s.naan, 1]]); // +₹40
    const again = ok(await call('GET', `${s.tableBase}/bill`, bearer(token))).bill;
    assert.equal(again.discountTotal, 54);

    const sitting = await TableSession.findOne({ tableId: s.table._id }).lean();
    const assembled = await billingService.assembleBill(sitting._id);
    await billingService.markPaid({ billId: assembled._id, restaurantId: s.restaurant._id, paymentMethod: 'cash' });
    const redeemed = await Discount.findById(offer.id).lean();
    assert.equal(redeemed.offerStatus, 'redeemed');
    assert.equal(String(redeemed.billId), String(assembled._id));
    assert.equal(redeemed.isOpen, false);

    const closed = await sessionOf(token);
    assert.equal(closed.status, 'converted');
    assert.ok((await eventTypes(closed)).includes('bill_paid'));
  });

  test('one open offer per table: a second diner at it is not eligible', async () => {
    const s = await setup();
    const first = await s.diner();
    const second = await s.diner();
    ok(await call('GET', `${s.base}/menu`, bearer(first)));
    ok(await call('GET', `${s.base}/menu`, bearer(second)));
    ok(await s.sendOffer((await sessionOf(first))._id), 201);
    const res = await s.sendOffer((await sessionOf(second))._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'TABLE_OFFER_OPEN');
    const secondId = String((await sessionOf(second))._id);
    const row = (await s.sessions()).find((r) => r.id === secondId);
    assert.equal(row.notEligibleReason, 'TABLE_OFFER_OPEN');
  });

  test('a revoked offer leaves the bill; an app guest still cannot be sent one', async () => {
    const s = await setup();
    const token = await s.diner();
    await s.order(token, [[s.paneer, 2]]);
    const { offer } = ok(await s.sendOffer((await sessionOf(token))._id), 201);
    assert.equal(ok(await call('GET', `${s.tableBase}/bill`, bearer(token))).bill.discountTotal, 50);
    ok(await call('POST', `/api/owner/${s.restaurant._id}/live/offers/${offer.id}/revoke`, authHeader(s.owner)));
    assert.equal(ok(await call('GET', `${s.tableBase}/bill`, bearer(token))).bill.discountTotal, 0);

    const appGuest = await CustomerSession.create({
      restaurantId: s.restaurant._id,
      userId: (await User.create({ role: 'guest', name: 'Guest' }))._id,
      isGuest: true,
      displayName: 'Guest',
      startedAt: t,
      lastActivityAt: t,
    });
    const res = await s.sendOffer(appGuest._id);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'GUEST_NOT_ELIGIBLE');
  });
});

describe('timeouts', () => {
  test('a diner who ordered stays open past 30 minutes; one who only browsed closes', async () => {
    const s = await setup();
    const eater = await s.diner();
    const browser = await s.diner();
    await s.order(eater, [[s.paneer, 1]]);
    ok(await call('GET', `${s.base}/menu`, bearer(browser)));
    t = new Date(T0 + 45 * MINUTE);
    await activity.sweepSessions(t);
    assert.equal((await sessionOf(eater)).status, 'idle');
    assert.equal((await sessionOf(browser)).status, 'ended');
    t = new Date(T0 + 5 * 60 * MINUTE);
    await activity.sweepSessions(t);
    assert.equal((await sessionOf(eater)).status, 'converted');
  });
});
