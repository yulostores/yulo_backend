// "Use my current location" in store settings: an owner can pin the restaurant's exact spot
// (PATCH /owner/:rId/restaurant { location }), a bad point is refused, and an ordinary
// settings save — which always sends the address — no longer re-geocodes it over the pin.
// Only an actual address change does. In-memory MongoDB; the geocoder's fetch is stubbed.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let owner;
let restaurant;
let geocodeCalls = 0;

// Where the "geocoder" puts every address: deliberately not where the owner is standing.
const GEOCODED = { lat: '18.5000', lon: '73.8000' };
const PINNED = { lat: 18.52345, lng: 73.85678 };

const realFetch = globalThis.fetch;
before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('nominatim') || href.includes('geocode')) {
      geocodeCalls += 1;
      return new Response(JSON.stringify([GEOCODED]), { status: 200 });
    }
    return realFetch(url, init);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  geocodeCalls = 0;
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    email: 'hello@spice.test',
    phone: '9876543210',
    address: { street: '12 Main Road', city: 'Pune', state: 'MH', pincode: '411001' },
    location: { type: 'Point', coordinates: [73.8, 18.5] },
    settings: { legalEntityType: 'Partnership', ownerName: 'Owner', panNumber: 'ABCDE1234F' },
    isActive: true,
    approvalStatus: 'active',
  });
});

const headers = () => ({ authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` });
const pin = (location) =>
  srv.request('PATCH', `/api/owner/${restaurant._id}/restaurant`, { headers: headers(), body: { location } });
const saveSettings = (body) =>
  srv.request('PATCH', `/api/owner/${restaurant._id}/settings`, { headers: headers(), body });
const storedPoint = async () => (await Restaurant.findById(restaurant._id).lean()).location.coordinates;

test('owner pins the exact location; it is stored as [lng, lat]', async () => {
  const res = await pin({ type: 'Point', coordinates: [PINNED.lng, PINNED.lat] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.restaurant.location.coordinates, [PINNED.lng, PINNED.lat]);
  assert.deepEqual(await storedPoint(), [PINNED.lng, PINNED.lat]);
});

test('a missing, out-of-range or [0, 0] point is refused and the old one kept', async () => {
  for (const location of [{}, { coordinates: [200, 10] }, { coordinates: [0, 0] }, { coordinates: ['x', 1] }]) {
    const res = await pin(location);
    assert.equal(res.status, 400, JSON.stringify(location));
    assert.equal(res.body.code ?? res.body.error?.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(await storedPoint(), [73.8, 18.5]);
});

test('saving settings with the same address keeps the pinned point (no re-geocode)', async () => {
  await pin({ type: 'Point', coordinates: [PINNED.lng, PINNED.lat] });
  const res = await saveSettings({
    name: 'Spice Route',
    address: { street: '12 Main Road', city: 'Pune', state: 'MH', pincode: '411001' },
  });
  assert.equal(res.status, 200);
  assert.equal(geocodeCalls, 0);
  assert.deepEqual(await storedPoint(), [PINNED.lng, PINNED.lat]);
});

test('changing the address re-geocodes it, replacing the old pin', async () => {
  await pin({ type: 'Point', coordinates: [PINNED.lng, PINNED.lat] });
  const res = await saveSettings({
    address: { street: '99 New Street', city: 'Pune', state: 'MH', pincode: '411001' },
  });
  assert.equal(res.status, 200);
  assert.equal(geocodeCalls, 1);
  assert.deepEqual(await storedPoint(), [Number(GEOCODED.lon), Number(GEOCODED.lat)]);
});
