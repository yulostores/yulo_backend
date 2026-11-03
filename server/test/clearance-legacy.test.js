// The clearance queue shows what the customer paid even for an order placed before the
// pricing engine (no `charges`, no payment amount — only its rupee grandTotal). It used to
// show "—" for those.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { clearanceQueue } = await import('../services/payoutView.service.js');
const { default: Order } = await import('../models/Order.js');
const { makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

let mongo;
before(async () => {
  mongo = await startMemoryMongo();
});
after(async () => {
  await mongo?.stop();
});

test('a legacy online order shows its grand total as what the customer paid', async () => {
  const { restaurant } = await makeRestaurant();
  await Order.collection.insertOne({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'out_for_delivery',
    paymentStatus: 'paid',
    paymentMethod: 'online',
    grandTotal: 162,
    items: [],
    createdAt: new Date('2026-09-08T10:00:00Z'),
  });
  const { rows } = await clearanceQueue({ restaurantId: restaurant._id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customerPaidPaise, 16200);
});
