// GET /api/restaurants/:id/menu/categories — the per-section "N items" counts the customer
// app shows above each menu section. `foodType` narrows the counts to one diet so a section
// doesn't read "7 items" above "Nothing here for this filter"; without it every available
// item is counted, as before.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { getMenuCategories } = await import('../services/menu.service.js');

let mongo;
const restaurantId = new mongoose.Types.ObjectId();

before(async () => {
  mongo = await startMemoryMongo();
  const [drinks, mains] = await Category.create([
    { restaurantId, name: 'Drinks', displayOrder: 1 },
    { restaurantId, name: 'Mains', displayOrder: 2 },
  ]);
  const item = (categoryId, name, foodType, isAvailable = true) => ({
    restaurantId,
    categoryId,
    name,
    foodType,
    sellingPrice: 100,
    isAvailable,
  });
  await MenuItem.create([
    item(drinks._id, 'Tea', 'veg'),
    item(drinks._id, 'Coffee', 'veg'),
    item(mains._id, 'Paneer Tikka', 'veg'),
    item(mains._id, 'Chicken Curry', 'non_veg'),
    item(mains._id, 'Egg Curry', 'egg'),
    item(mains._id, 'Mutton Biryani', 'non_veg', false), // unavailable — never counted
  ]);
});

after(async () => {
  await mongo.stop();
});

const counts = (categories) => Object.fromEntries(categories.map((c) => [c.name, c.itemCount]));

test('without a foodType every available item is counted', async () => {
  assert.deepEqual(counts(await getMenuCategories(restaurantId)), { Drinks: 2, Mains: 3 });
});

test('foodType narrows each section to that diet', async () => {
  assert.deepEqual(counts(await getMenuCategories(restaurantId, 'veg')), { Drinks: 2, Mains: 1 });
  assert.deepEqual(counts(await getMenuCategories(restaurantId, 'non_veg')), { Drinks: 0, Mains: 1 });
  assert.deepEqual(counts(await getMenuCategories(restaurantId, 'egg')), { Drinks: 0, Mains: 1 });
});

test('an unknown foodType is ignored rather than counting nothing', async () => {
  assert.deepEqual(counts(await getMenuCategories(restaurantId, 'all')), { Drinks: 2, Mains: 3 });
  assert.deepEqual(counts(await getMenuCategories(restaurantId, 'vegan')), { Drinks: 2, Mains: 3 });
});
