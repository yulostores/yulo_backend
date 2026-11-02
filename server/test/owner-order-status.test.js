// The owner moving orders on themselves (PATCH /api/owner/:rid/orders/:orderId/status) when the
// chef or waiter is busy: QR dine-in rounds through preparing → ready → served, customer-app
// delivery and takeaway orders through the kitchen steps, cancelling with a reason, and the
// limits — a 'placed' order is Accept/Reject's, 'served' is dine-in only, and once a rider has
// a delivery the pickup and doorstep codes move it, not the restaurant.
// In-memory MongoDB and the real HTTP API.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateTokens } = await import('../services/auth.service.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: User } = await import('../models/User.js');
const { default: Bill } = await import('../models/Bill.js');
const { authHeader, makeDeliveryCustomer, makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

let mongo;
let srv;
let s;

const call = (method, path, headers = {}, body) => srv.request(method, path, { headers, body });
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};
const expectError = (res, status, code) => {
  assert.equal(res.status, status, `${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.equal(res.body.code, code);
};

const move = (orderId, newStatus, extra = {}) =>
  call('PATCH', `/api/owner/${s.restaurant._id}/orders/${orderId}/status`, authHeader(s.owner), { newStatus, ...extra });
const accept = (orderId) => call('PATCH', `/api/owner/${s.restaurant._id}/orders/${orderId}/accept`, authHeader(s.owner));

/** A QR (yulo_menu) round at table T3, accepted. */
const qrRound = async () => {
  const table = await Table.create({ restaurantId: s.restaurant._id, identifier: 'T3' });
  const { order } = ok(
    await call('POST', `/api/restaurants/${s.restaurant._id}/tables/${table._id}/orders`, { 'Idempotency-Key': `k-${Math.random()}` }, {
      items: [{ menuItemId: String(s.paneer._id), quantity: 2 }],
    }),
    201
  );
  ok(await accept(order._id));
  return order._id;
};

/** A customer-app cash-on-delivery order, accepted. */
const appOrder = async () => {
  const customer = await makeDeliveryCustomer();
  ok(await call('POST', '/api/cart/items', authHeader(customer), { menuItemId: String(s.paneer._id), qty: 1 }), 201);
  const { order } = ok(await call('POST', '/api/orders/checkout', authHeader(customer), { paymentMethod: 'cod' }), 201);
  ok(await accept(order._id));
  return order._id;
};

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});

after(async () => {
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  s = await makeRestaurant();
  const admin = await User.create({ name: 'Admin', email: `admin${Date.now()}@test.local`, role: 'admin' });
  ok(
    await call('POST', '/api/admin/finance/settings', { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` }, {
      settings: { codEnabled: true },
      note: 'COD for owner status tests',
    }),
    201
  );
});

describe('QR dine-in rounds', () => {
  test('the owner takes a round through preparing → ready → served, recorded as the owner', async () => {
    const id = await qrRound();
    ok(await move(id, 'preparing'));
    ok(await move(id, 'ready'));
    const { order } = ok(await move(id, 'served'));
    assert.equal(order.status, 'served');
    assert.ok(order.servedAt);
    const steps = (await Order.findById(id).lean()).statusHistory.map((h) => [h.status, h.byRole]);
    assert.deepEqual(steps.slice(-3), [['preparing', 'owner'], ['ready', 'owner'], ['served', 'owner']]);
  });

  test('a waiting order is still Accept / Reject only', async () => {
    const table = await Table.create({ restaurantId: s.restaurant._id, identifier: 'T4' });
    const { order } = ok(
      await call('POST', `/api/restaurants/${s.restaurant._id}/tables/${table._id}/orders`, { 'Idempotency-Key': 'k-wait' }, {
        items: [{ menuItemId: String(s.naan._id), quantity: 1 }],
      }),
      201
    );
    expectError(await move(order._id, 'preparing'), 409, 'ORDER_AWAITING_APPROVAL');
  });

  test('cancelling needs a reason for the customer, and records it', async () => {
    const id = await qrRound();
    expectError(await move(id, 'cancelled'), 400, 'VALIDATION_ERROR');
    const { order } = ok(await move(id, 'cancelled', { reason: 'Out of paneer' }));
    assert.equal(order.status, 'cancelled');
    const stored = await Order.findById(id).lean();
    assert.equal(stored.cancelledBy, 'restaurant');
    assert.equal(stored.cancellationReason, 'Out of paneer');
  });

  test('a skipped step is refused like anywhere else', async () => {
    const id = await qrRound();
    expectError(await move(id, 'delivered'), 400, 'INVALID_TRANSITION');
  });
});

describe('customer-app orders', () => {
  test('delivery: kitchen steps yes; served no; out for delivery / delivered stay the rider\'s once one has it', async () => {
    const id = await appOrder();
    ok(await move(id, 'preparing'));
    expectError(await move(id, 'served'), 400, 'INVALID_TRANSITION');
    ok(await move(id, 'ready'));
    await Order.updateOne({ _id: id }, { $set: { 'deliveryAssignment.status': 'assigned' } });
    expectError(await move(id, 'out_for_delivery'), 409, 'RIDER_HANDLES_DELIVERY');
    expectError(await move(id, 'delivered'), 409, 'RIDER_HANDLES_DELIVERY');
  });

  test('delivery with no rider: the restaurant can send it out and close it itself', async () => {
    const id = await appOrder();
    await Order.updateOne({ _id: id }, { $set: { 'deliveryAssignment.status': 'unassigned' } });
    ok(await move(id, 'preparing'));
    ok(await move(id, 'ready'));
    ok(await move(id, 'out_for_delivery'));
    const { order } = ok(await move(id, 'delivered'));
    assert.equal(order.status, 'delivered');
    assert.equal((await Order.findById(id).lean()).paymentStatus, 'paid', 'cash collected on delivery');
    assert.ok(await Bill.exists({ orderId: id }), 'the order gets its bill');
  });

  test('takeaway: handed over at the counter (ready → delivered)', async () => {
    const id = await appOrder();
    await Order.updateOne({ _id: id }, { $set: { type: 'takeaway' } });
    ok(await move(id, 'preparing'));
    ok(await move(id, 'ready'));
    expectError(await move(id, 'out_for_delivery'), 400, 'INVALID_TRANSITION');
    const { order } = ok(await move(id, 'delivered'));
    assert.equal(order.status, 'delivered');
  });

  test('another restaurant\'s owner cannot touch it', async () => {
    const id = await appOrder();
    const other = await makeRestaurant({ name: 'Other' });
    const res = await call('PATCH', `/api/owner/${s.restaurant._id}/orders/${id}/status`, authHeader(other.owner), { newStatus: 'preparing' });
    assert.equal(res.status, 403);
  });
});
