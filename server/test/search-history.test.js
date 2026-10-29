// Recent searches — one entry per query regardless of case. "Pizza" then "pizza" used to
// leave both in the customer's list.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { default: SearchHistory } = await import('../models/SearchHistory.js');
const { recordSearch, listRecentSearches } = await import('../services/search.service.js');

let mongo;
const userId = new mongoose.Types.ObjectId();

before(async () => {
  mongo = await startMemoryMongo();
});

beforeEach(async () => {
  await mongo.clear();
});

after(async () => {
  await mongo.stop();
});

const queries = async () => (await listRecentSearches(userId)).map((r) => r.query);

test('re-searching in a different case replaces the old entry and moves it to the top', async () => {
  await recordSearch(userId, 'Pizza');
  await recordSearch(userId, 'dosa');
  await recordSearch(userId, 'pizza');
  assert.deepEqual(await queries(), ['pizza', 'dosa']);
  assert.equal(await SearchHistory.countDocuments({ userId }), 2);
});

test('history saved before the fix is shown once per query, newest spelling kept', async () => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  await SearchHistory.collection.insertMany([
    { userId, query: 'Sandwich', createdAt: at(30) },
    { userId, query: 'biryani', createdAt: at(20) },
    { userId, query: 'sandwich', createdAt: at(10) },
  ]);
  assert.deepEqual(await queries(), ['sandwich', 'biryani']);
});

test('regex characters in a query are matched literally', async () => {
  await recordSearch(userId, 'c++ (veg)');
  await recordSearch(userId, 'C++ (VEG)');
  await recordSearch(userId, 'cxx veg');
  assert.deepEqual(await queries(), ['cxx veg', 'C++ (VEG)']);
});
