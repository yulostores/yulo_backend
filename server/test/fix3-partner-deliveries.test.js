// A rider's totalDeliveries counts each delivered order exactly once — whether the rider or the
// kitchen closed it out, or both — and the backfill counts deliveries made before it was kept.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generatePartnerTokens } = await import('../services/auth.service.js');
const kitchenService = await import('../services/kitchen.service.js');
const { countCompletedDelivery } = await import('../services/deliveryAssignment.service.js');
const { backfillPartnerDeliveries } = await import('../scripts/backfillPartnerDeliveries.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');

let mongo;
let srv;
let restaurant;
let rider;

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
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [77.59, 12.97] } });
  rider = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'busy', verificationStatus: 'approved' });
});

// A cash order out for delivery with the rider holding it — no online-payment side effects.
const outForDelivery = (assignment = {}) =>
  Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 300,
    paymentMethod: 'cash',
    paymentStatus: 'pending',
    status: 'out_for_delivery',
    deliveryAssignment: { partnerId: rider._id, status: 'picked_up', ...assignment },
  });

const totalOf = async () => (await DeliveryPartner.findById(rider._id).lean()).totalDeliveries;
const riderHeaders = () => ({ authorization: `Bearer ${generatePartnerTokens(rider._id).accessToken}` });

test('the rider delivering counts once; the kitchen closing it out afterwards adds nothing', async () => {
  const order = await outForDelivery();
  const res = await srv.request('POST', `/api/partner/orders/${order._id}/deliver`, { headers: riderHeaders(), body: { codCollected: 300 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await totalOf(), 1);
  assert.ok((await Order.findById(order._id).lean()).deliveryAssignment.countedAt);

  // Reported again from any path → still 1.
  assert.equal(await countCompletedDelivery(order._id), false);
  assert.equal(await totalOf(), 1);
});

test('the kitchen marking a delivery delivered counts it; with no rider assigned nothing is counted', async () => {
  const order = await outForDelivery();
  await kitchenService.updateOrderStatus({ orderId: order._id, currentStatus: 'out_for_delivery', newStatus: 'delivered', actor: { role: 'chef' } });
  assert.equal(await totalOf(), 1);

  const riderless = await outForDelivery({ partnerId: null, status: 'unassigned' });
  await kitchenService.updateOrderStatus({ orderId: riderless._id, currentStatus: 'out_for_delivery', newStatus: 'delivered', actor: { role: 'chef' } });
  assert.equal(await totalOf(), 1);
});

test('the same delivery reported from two paths at once is counted once', async () => {
  const order = await outForDelivery({ status: 'delivered' });
  const results = await Promise.all([countCompletedDelivery(order._id), countCompletedDelivery(order._id), countCompletedDelivery(order._id)]);
  assert.deepEqual(results.sort(), [false, false, true]);
  assert.equal(await totalOf(), 1);
});

test('backfill: dry run writes nothing; apply counts past deliveries once; a re-run finds nothing', async () => {
  await outForDelivery({ status: 'delivered' });
  await outForDelivery({ status: 'delivered' });
  await outForDelivery({ status: 'delivered', countedAt: new Date() }); // already counted live
  await outForDelivery(); // not delivered yet
  const quiet = () => {};

  assert.deepEqual(await backfillPartnerDeliveries({ apply: false, log: quiet }), { partners: 1, orders: 2, counted: 0 });
  assert.equal(await totalOf(), 0);

  assert.deepEqual(await backfillPartnerDeliveries({ apply: true, log: quiet }), { partners: 1, orders: 2, counted: 2 });
  assert.equal(await totalOf(), 2);

  assert.deepEqual(await backfillPartnerDeliveries({ apply: true, log: quiet }), { partners: 0, orders: 0, counted: 0 });
  assert.equal(await totalOf(), 2);
});
