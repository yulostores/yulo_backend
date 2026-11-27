// A dish priced "with tax" (MenuItem.priceIncludesGst): its order line snapshots the flag, and the
// table's bill takes the GST out of that price instead of adding it. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { generateTokens } = await import('../services/auth.service.js');
const { createOrder } = await import('../services/order.service.js');

let mongo;
let srv;
let seed;

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
  seed = await seedBasics(); // GST-registered restaurant, 5 % food GST
});

test('dine-in: a ₹105 "with tax" dish and a ₹200 one → GST split out of the first, added to the second', async () => {
  const inclusive = await MenuItem.create({ restaurantId: seed.restaurant._id, categoryId: seed.dish.categoryId, name: 'Thali (with tax)', foodType: 'veg', sellingPrice: 105, priceIncludesGst: true, hsnCode: '996331' });
  const table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T1' });
  const session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const order = await createOrder({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    items: [
      { menuItemId: inclusive._id, quantity: 1 },
      { menuItemId: seed.dish._id, quantity: 1 },
    ],
    placedBy: 'waiter',
  });
  const stored = await Order.findById(order._id).lean();
  assert.deepEqual(stored.items.map((i) => i.priceIncludesGst), [true, false], 'the flag is snapshotted on the line');
  await Order.updateOne({ _id: order._id }, { $set: { status: 'served' } });

  const owner = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  const gen = await srv.request('POST', `/api/owner/${seed.restaurant._id}/bills/sessions/${session._id}/generate`, { headers: owner });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const bill = gen.body.data.bill;
  const dishPrice = seed.dish.sellingPrice;
  const food = bill.chargeBreakdown.food;
  assert.equal(food.inclusive, 10500);
  assert.equal(food.gstIncluded, 500, '₹5 of the ₹105 is GST');
  assert.equal(food.gstAdded, Math.round(dishPrice * 100 * 0.05));
  assert.equal(food.total, 10500 + dishPrice * 100 + food.gstAdded, 'the "with tax" dish costs exactly ₹105');
  assert.equal(bill.batches[0].items.find((i) => i.name.startsWith('Thali (with tax)')).priceIncludesGst, true);

  // The bill screens' CGST/SGST rows show only the GST ADDED on top, so the rows add up to the
  // total; the GST inside the "with tax" price is reported separately.
  const c = bill.charges;
  assert.equal(c.gstAmount, food.gstAdded / 100);
  assert.equal(c.gstIncludedAmount, 5);
  assert.equal(c.totalGstAmount, food.gst / 100);
  assert.equal(c.cgstAmount + c.sgstAmount, c.gstAmount);
  const rows = c.subtotal + c.gstAmount + c.platformFee + (c.serviceChargeAmount ?? 0) + c.roundOff - c.discountTotal;
  assert.ok(Math.abs(rows - c.grandTotal) < 0.01, `bill rows ${rows} add up to the total ${c.grandTotal}`);
});
