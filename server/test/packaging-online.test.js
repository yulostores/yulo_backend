// Per-dish packaging charge (delivery/takeaway only, food GST on it) and "online available"
// (off = dine-in only: hidden from the delivery app, refused in carts, still on the table menu).

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Table } = await import('../models/Table.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const { getActiveSettings } = await import('../services/financeSettings.service.js');
const { placeGuestOrder } = await import('../services/guestOrder.service.js');

let mongo;
let srv;
let seed;
let dineInOnly;

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
  seed = await seedBasics();
  dineInOnly = await MenuItem.create({
    restaurantId: seed.restaurant._id,
    categoryId: seed.dish.categoryId,
    name: 'Tandoori Platter',
    foodType: 'veg',
    sellingPrice: 400,
    availableOnline: false,
  });
});

test('packaging: × quantity on delivery/takeaway with food GST, never on dine-in', async () => {
  const settings = await getActiveSettings();
  const restaurant = { gstRegistered: true, delivery: {} };
  const takeaway = computeCustomerCharges({
    orderType: 'takeaway', foodSubtotalPaise: 30000, restaurant, packagingPaise: 2000, settings,
  });
  assert.equal(takeaway.packaging.base, 2000);
  assert.equal(takeaway.packaging.gst, Math.round(2000 * settings.foodGstPercent / 100));
  const line = takeaway.lines.find((l) => l.key === 'packaging');
  assert.equal(line.label, 'Packaging charge');
  assert.equal(line.amountPaise, takeaway.packaging.total);
  assert.equal(takeaway.subtotalBeforeRoundOff, takeaway.food.total + takeaway.packaging.total + takeaway.platformFee.total);

  const dineIn = computeCustomerCharges({
    orderType: 'dine_in', foodSubtotalPaise: 30000, restaurant, packagingPaise: 2000, settings,
  });
  assert.equal(dineIn.packaging.total, 0);
  assert.equal(dineIn.lines.some((l) => l.key === 'packaging'), false);
});

test('online available off: not on the delivery menu or in carts, still on the table menu and orderable there', async () => {
  const id = String(dineInOnly._id);
  const online = await srv.get(`/api/restaurants/${seed.restaurant._id}/menu`);
  const onlineIds = online.body.data.menu.flatMap((c) => [...(c.items ?? []), ...(c.subCategories ?? []).flatMap((s) => s.items)]).map((i) => String(i._id));
  assert.equal(onlineIds.includes(id), false);
  assert.equal(onlineIds.includes(String(seed.dish._id)), true);

  const table = await srv.get(`/api/restaurants/${seed.restaurant._id}/menu?channel=dine_in`);
  const tableIds = table.body.data.menu.flatMap((c) => [...(c.items ?? []), ...(c.subCategories ?? []).flatMap((s) => s.items)]).map((i) => String(i._id));
  assert.equal(tableIds.includes(id), true);

  const cart = await srv.request('POST', '/api/cart/items', {
    headers: { authorization: `Bearer ${seed.customerToken}` },
    body: { menuItemId: id, qty: 1 },
  });
  assert.equal(cart.status, 400);
  assert.equal(cart.body.code, 'NOT_AVAILABLE_ONLINE');

  const t = await Table.create({ restaurantId: seed.restaurant._id, identifier: '3' });
  const { order } = await placeGuestOrder({ restaurantId: seed.restaurant._id, tableId: t._id, items: [{ menuItemId: id, quantity: 1 }] });
  assert.equal(order.items[0].name, 'Tandoori Platter');
});
