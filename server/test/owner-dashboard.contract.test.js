// The owner dashboard's KPIs, sales chart and top items in the shape API.md documents and the
// restaurant portal reads ({ orders, avgOrderValue, dineIn, delivery, … } and parallel chart
// arrays), honouring `period`, with days drawn in India time. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const dashboard = await import('../services/dashboard.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');

let mongo;
let restaurant;

before(async () => {
  mongo = await startMemoryMongo();
});
after(async () => {
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [77.59, 12.97] } });
});

// 30 Oct 2026, 22:00 IST.
const AT = new Date('2026-10-30T16:30:00.000Z');

const order = (fields) =>
  Order.collection.insertOne({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'delivered',
    paymentMethod: 'online',
    paymentStatus: 'paid',
    subtotal: 100,
    items: [{ menuItemId: restaurant._id, name: 'Dal', price: 100, quantity: 1 }],
    ...fields,
  });

test('KPIs: documented fields, the IST day (02:00 IST counts as today), cancelled and unpaid kept apart', async () => {
  const userId = (await User.create({ name: 'C', phone: '9000000001', role: 'customer' }))._id;
  await order({ createdAt: new Date('2026-10-29T20:30:00.000Z'), subtotal: 240, userId }); // 02:00 IST today
  await order({ createdAt: new Date('2026-10-30T10:00:00.000Z'), subtotal: 180, type: 'dine_in', paymentMethod: 'cash' });
  await order({ createdAt: new Date('2026-10-30T11:00:00.000Z'), status: 'cancelled' });
  await order({ createdAt: new Date('2026-10-30T12:00:00.000Z'), paymentStatus: 'pending' }); // unpaid online: not an order yet
  await order({ createdAt: new Date('2026-10-29T18:00:00.000Z'), subtotal: 999 }); // 23:30 IST yesterday

  const today = await dashboard.getKPIs(restaurant._id, 'today', AT);
  assert.equal(today.period, 'today');
  assert.equal(today.orders, 2);
  assert.equal(today.dineIn, 1);
  assert.equal(today.delivery, 1);
  assert.equal(today.cancelledOrders, 1);
  assert.equal(today.revenue, 420);
  assert.equal(today.avgOrderValue, 210);
  assert.equal(today.newCustomers, 1);

  const week = await dashboard.getKPIs(restaurant._id, 'week', AT);
  assert.equal(week.orders, 3);
  assert.equal(week.revenue, 1419);
  assert.equal(week.newCustomers, 1, 'the customer\'s first order is still inside the week');
});

test('sales chart: parallel arrays, zero-filled, hourly for today, 7 days for week, 12 months for year', async () => {
  await order({ createdAt: new Date('2026-10-30T16:20:00.000Z'), subtotal: 240 }); // 21:50 IST
  await order({ createdAt: new Date('2026-10-28T06:30:00.000Z'), subtotal: 180 }); // 28 Oct, 12:00 IST
  await order({ createdAt: new Date('2026-06-15T06:30:00.000Z'), subtotal: 50 });

  const today = await dashboard.getSalesChart(restaurant._id, 'today', AT);
  assert.equal(today.labels.length, 24);
  assert.equal(today.labels[21], '9 pm');
  assert.equal(today.revenue[21], 240);
  assert.equal(today.orders.reduce((a, b) => a + b, 0), 1);

  const week = await dashboard.getSalesChart(restaurant._id, 'week', AT);
  assert.equal(week.labels.length, 7);
  assert.deepEqual(week.revenue, [0, 0, 0, 0, 180, 0, 240]);
  assert.equal(week.labels.at(-1), 'Fri');

  const year = await dashboard.getSalesChart(restaurant._id, 'year', AT);
  assert.equal(year.labels.length, 12);
  assert.equal(year.labels.at(-1), 'Oct');
  assert.equal(year.revenue.at(-1), 420);
  assert.equal(year.revenue.at(-5), 50, 'June');
});

test('top items honour the period', async () => {
  await order({ createdAt: new Date('2026-10-30T10:00:00.000Z') });
  await order({ createdAt: new Date('2026-01-10T10:00:00.000Z') });
  const [today] = await dashboard.getTopItems(restaurant._id, 5, 'today', AT);
  assert.equal(today.totalQty, 1);
  const [all] = await dashboard.getTopItems(restaurant._id, 5, null, AT);
  assert.equal(all.totalQty, 2);
});

test('live monitor GMV is today\'s (IST) paid food value, the same as the dashboard revenue', async () => {
  const liveMonitor = await import('../services/liveMonitor.service.js');
  await order({ createdAt: new Date('2026-10-29T20:30:00.000Z'), subtotal: 240 }); // 02:00 IST today
  await order({ createdAt: new Date('2026-10-30T10:00:00.000Z'), subtotal: 180 });
  await order({ createdAt: new Date('2026-10-30T11:00:00.000Z'), status: 'cancelled' });
  await order({ createdAt: new Date('2026-10-29T18:00:00.000Z'), subtotal: 999 }); // yesterday IST
  const stats = await liveMonitor.getStats(restaurant._id, AT);
  assert.equal(stats.gmv, 420);
  assert.equal(stats.gmv, (await dashboard.getKPIs(restaurant._id, 'today', AT)).revenue);
});
