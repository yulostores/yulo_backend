// Owner menu items: prices are checked (a "discount" can't be above the MRP; an empty one
// clears it), the category has to be the restaurant's own, and an update only writes the
// fields the item form edits — never restaurantId. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateTokens } = await import('../services/auth.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');

let mongo;
let srv;
let owner;
let restaurant;
let category;
let otherRestaurant;
let otherCategory;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  const other = await User.create({ name: 'P', email: 'p@test.local', role: 'restaurant_owner' });
  const at = { type: 'Point', coordinates: [73.78, 18.56] };
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Hub', location: at, approvalStatus: 'active' });
  otherRestaurant = await Restaurant.create({ ownerId: other._id, name: 'Elsewhere', location: at, approvalStatus: 'active' });
  category = await Category.create({ restaurantId: restaurant._id, name: 'Biryani' });
  otherCategory = await Category.create({ restaurantId: otherRestaurant._id, name: 'Theirs' });
});

const headers = () => ({ authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` });
const create = (body) =>
  srv.request('POST', `/api/owner/${restaurant._id}/menu-items`, {
    headers: headers(),
    body: { name: 'Chicken Biryani', foodType: 'non_veg', categoryId: String(category._id), sellingPrice: '280', ...body },
  });
const update = (id, body) => srv.request('PATCH', `/api/owner/${restaurant._id}/menu-items/${id}`, { headers: headers(), body });

test('a discounted price above the MRP is refused; at or below it is kept', async () => {
  const above = await create({ discountedPrice: '300' });
  assert.equal(above.status, 400, JSON.stringify(above.body));
  assert.equal(await MenuItem.countDocuments(), 0);

  const ok = await create({ discountedPrice: '249' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.item.discountedPrice, 249);

  const raise = await update(ok.body.data.item._id, { discountedPrice: '281' });
  assert.equal(raise.status, 400);
  const lowerMrp = await update(ok.body.data.item._id, { sellingPrice: '200' });
  assert.equal(lowerMrp.status, 400, 'the stored discount (249) would sit above a ₹200 MRP');
});

test('an empty discount means none — and clears an existing one on edit', async () => {
  const none = await create({ discountedPrice: '' });
  assert.equal(none.status, 201);
  assert.equal(none.body.data.item.discountedPrice, null, 'not ₹0');

  const withDiscount = await create({ name: 'Mutton Biryani', discountedPrice: '249' });
  const cleared = await update(withDiscount.body.data.item._id, { discountedPrice: '' });
  assert.equal(cleared.status, 200);
  assert.equal((await MenuItem.findById(withDiscount.body.data.item._id)).discountedPrice, null);
});

test('prices must be positive amounts', async () => {
  for (const sellingPrice of ['0', '-5', 'abc', '']) {
    assert.equal((await create({ sellingPrice })).status, 400, sellingPrice);
  }
  assert.equal((await create({ discountedPrice: '0' })).status, 400);
});

test('an update cannot move the item to another restaurant or write unlisted fields', async () => {
  const { body } = await create({});
  const id = body.data.item._id;
  const res = await update(id, { restaurantId: String(otherRestaurant._id), isAvailable: false, name: 'Renamed' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await MenuItem.findById(id).lean();
  assert.equal(String(stored.restaurantId), String(restaurant._id));
  assert.equal(stored.isAvailable, true, 'availability changes go through the toggle');
  assert.equal(stored.name, 'Renamed');
});

test('the category has to be one of the restaurant’s own', async () => {
  assert.equal((await create({ categoryId: String(otherCategory._id) })).status, 400);
  const { body } = await create({});
  assert.equal((await update(body.data.item._id, { categoryId: String(otherCategory._id) })).status, 400);
});
