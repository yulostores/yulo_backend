// GET /api/owner/geocode — the registration map's "Find my address" lookup. Only the parts that
// never reach a real geocoder are exercised here (auth, input checks); the lookup itself is
// services/geocode.service.js, shared with restaurant creation.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let auth;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
  const owner = await User.create({ name: 'Owner', email: 'geo@test.local', phone: '9876500000', role: 'restaurant_owner' });
  auth = { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` };
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

test('owner geocode: needs an owner login', async () => {
  assert.equal((await srv.get('/api/owner/geocode?city=Pune')).status, 401);
});

test('owner geocode: needs at least a city or PIN code', async () => {
  const res = await srv.get('/api/owner/geocode?street=FC%20Road', auth);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /city or PIN code/);
});
