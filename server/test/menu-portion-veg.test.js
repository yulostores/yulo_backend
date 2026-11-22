// Half / full plate prices and pure-veg restaurants. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: OptionGroup } = await import('../models/OptionGroup.js');
const { default: Table } = await import('../models/Table.js');
const { generateTokens } = await import('../services/auth.service.js');
const { placeGuestOrder } = await import('../services/guestOrder.service.js');

let mongo;
let srv;
let owner;
let restaurant;
let category;

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
  owner = await User.create({ name: 'Owner', email: 'o@test.local', phone: '9876511111', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Dhaba',
    location: { type: 'Point', coordinates: [73.84, 18.52] },
    approvalStatus: 'active',
    isActive: true,
  });
  category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
});

const auth = () => ({ authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` });
const itemForm = (fields) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ name: 'Paneer Tikka', categoryId: String(category._id), foodType: 'veg', sellingPrice: '200', ...fields })) {
    form.append(k, v);
  }
  return form;
};
const createItem = async (fields) => {
  const res = await fetch(`${srv.base}/api/owner/${restaurant._id}/menu-items`, { method: 'POST', headers: auth(), body: itemForm(fields) });
  return { status: res.status, body: await res.json() };
};

test('half plate price: saved, mirrored as a "Plate size" option group, kept in step on edit and removed when cleared', async () => {
  const created = await createItem({ halfPlatePrice: '120' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.item._id;
  assert.equal(created.body.data.item.halfPlatePrice, 120);

  let group = await OptionGroup.findOne({ menuItemId: id, systemKey: 'portion' }).lean();
  assert.equal(group.title, 'Plate size');
  assert.deepEqual(group.options.map((o) => [o.name, o.priceDeltaMinor, o.isDefaultSelected]), [
    ['Full plate', 0, true],
    ['Half plate', -80, false],
  ]);

  const edit = (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return fetch(`${srv.base}/api/owner/${restaurant._id}/menu-items/${id}`, { method: 'PATCH', headers: auth(), body: form });
  };
  assert.equal((await edit({ sellingPrice: '220', halfPlatePrice: '130' })).status, 200);
  group = await OptionGroup.findOne({ menuItemId: id, systemKey: 'portion' }).lean();
  assert.equal(group.options.find((o) => o.name === 'Half plate').priceDeltaMinor, -90);

  assert.equal((await edit({ halfPlatePrice: '' })).status, 200);
  assert.equal(await OptionGroup.countDocuments({ menuItemId: id }), 0);
});

test('half plate price must be below the full plate', async () => {
  const res = await createItem({ halfPlatePrice: '200' });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /less than the full plate/);
});

test('table order: a half and a full plate of the same dish on one order, each priced and named', async () => {
  const item = await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Dal Makhani', foodType: 'veg', sellingPrice: 180, halfPlatePrice: 100 });
  const single = await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Roti', foodType: 'veg', sellingPrice: 20 });
  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'T1' });
  const { order } = await placeGuestOrder({
    restaurantId: restaurant._id,
    tableId: table._id,
    items: [
      { menuItemId: String(item._id), quantity: 1, portion: 'half' },
      { menuItemId: String(item._id), quantity: 2, portion: 'full' },
      { menuItemId: String(single._id), quantity: 3 },
    ],
  });
  const lines = order.items.map((i) => [i.name, i.price, i.quantity, i.portion]);
  assert.deepEqual(lines, [
    ['Dal Makhani (Half)', 100, 1, 'half'],
    ['Dal Makhani (Full)', 180, 2, 'full'],
    ['Roti', 20, 3, null],
  ]);

  await assert.rejects(
    placeGuestOrder({ restaurantId: restaurant._id, tableId: table._id, items: [{ menuItemId: String(single._id), quantity: 1, portion: 'half' }] }),
    /not sold as a half plate/
  );
});

test('pure veg: non-veg dishes are refused, and switching to pure veg waits until none are left', async () => {
  await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Chicken Curry', foodType: 'non_veg', sellingPrice: 250 });
  const toPureVeg = () =>
    srv.request('PATCH', `/api/owner/${restaurant._id}/restaurant`, { headers: auth(), body: { isPureVeg: true } });
  const refused = await toPureVeg();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NON_VEG_ITEMS');

  await MenuItem.updateMany({ restaurantId: restaurant._id }, { $set: { isAvailable: false } });
  assert.equal((await toPureVeg()).status, 200);
  const nonVeg = await createItem({ name: 'Egg Curry', foodType: 'egg' });
  assert.equal(nonVeg.status, 400);
  assert.match(nonVeg.body.message, /Pure-veg/);
  assert.equal((await createItem({ name: 'Aloo Gobi' })).status, 201);
});

test('registration: the owner must choose pure veg or veg & non-veg', async () => {
  const other = await User.create({ name: 'New', email: 'n@test.local', phone: '9876522222', role: 'restaurant_owner' });
  const headers = { authorization: `Bearer ${generateTokens(other._id, 'restaurant_owner').accessToken}` };
  const body = {
    name: 'Green Leaf',
    address: { street: 'FC Road', city: 'Pune', state: 'Maharashtra', pincode: '411004' },
    location: { type: 'Point', coordinates: [73.84, 18.52] },
  };
  const missing = await srv.request('POST', '/api/owner/restaurants', { headers, body });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.details.fieldErrors.isPureVeg);
  const ok = await srv.request('POST', '/api/owner/restaurants', { headers, body: { ...body, isPureVeg: true } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.restaurant.isPureVeg, true);
});
