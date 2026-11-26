// The super admin dashboard's platform totals include sellers, counted by status.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { default: Seller } = await import('../models/Seller.js');
const { getPlatformTotals } = await import('../services/adminStats.service.js');

let mongo;
before(async () => {
  mongo = await startMemoryMongo();
});
after(async () => {
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
});

test('no sellers: every status is 0', async () => {
  const totals = await getPlatformTotals();
  assert.deepEqual(totals.sellers, { pending: 0, active: 0, suspended: 0, rejected: 0 });
});

test('sellers are counted by status', async () => {
  await Seller.collection.insertMany([
    { businessName: 'A', status: 'active' },
    { businessName: 'B', status: 'active' },
    { businessName: 'C', status: 'pending' },
    { businessName: 'D', status: 'suspended' },
    { businessName: 'E', status: 'rejected' },
  ]);
  const totals = await getPlatformTotals();
  assert.deepEqual(totals.sellers, { pending: 1, active: 2, suspended: 1, rejected: 1 });
});
