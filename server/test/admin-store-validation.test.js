// Admin store edits are held to the same rules as creating a store: delivery charges in range
// (a negative radius used to be saved and then read as "unset" — the full 25 km), well-formed
// opening hours, and map coordinates inside real latitude / longitude.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateTokens } = await import('../services/auth.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { makeRestaurant } = await import('../test-utils/liveFixtures.mjs');

let mongo;
let srv;
let admin;
let restaurant;

const patch = (path, body) => srv.request('PATCH', `/api/admin/stores/${restaurant._id}${path}`, { headers: admin, body });

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
  const user = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  admin = { authorization: `Bearer ${generateTokens(user._id, 'admin').accessToken}` };
  ({ restaurant } = await makeRestaurant());
});

test('a negative or too-large delivery radius is refused; a valid one saves', async () => {
  for (const radiusKm of [-3, 26]) {
    const res = await patch('', { delivery: { radiusKm } });
    assert.equal(res.status, 400, `radius ${radiusKm}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  const res = await patch('', { delivery: { radiusKm: 6, baseCharge: 20 } });
  assert.equal(res.status, 200);
  assert.equal((await Restaurant.findById(restaurant._id).lean()).delivery.radiusKm, 6);
});

test('negative charges and impossible minutes are refused', async () => {
  for (const delivery of [{ baseCharge: -1 }, { freeThreshold: -10 }, { estimatedMinutes: 1441 }, { estimatedMinutes: 12.5 }]) {
    const res = await patch('', { delivery });
    assert.equal(res.status, 400, JSON.stringify(delivery));
  }
});

test('opening hours must be real days and times', async () => {
  const bad = await patch('', { operatingHours: [{ day: 'funday', isOpen: true, openTime: 900, closeTime: 2200 }] });
  assert.equal(bad.status, 400);
  const late = await patch('', { operatingHours: [{ day: 'monday', isOpen: true, openTime: 900, closeTime: 2500 }] });
  assert.equal(late.status, 400);
  const ok = await patch('', { operatingHours: [{ day: 'monday', isOpen: true, openTime: 900, closeTime: 2300 }] });
  assert.equal(ok.status, 200);
});

test('map coordinates must be a real [longitude, latitude]', async () => {
  const bad = await patch('/location', { coordinates: [73.7, 118.5] });
  assert.equal(bad.status, 400);
  const ok = await patch('/location', { coordinates: [73.7795, 18.5625] });
  assert.equal(ok.status, 200);
});

test('hand-typed fields follow the store settings rules; blanks on optional ones are fine', async () => {
  const pin = await patch('', { address: { street: '1 Road', city: 'Pune', state: 'MH', pincode: '9000000079' } });
  assert.equal(pin.status, 400);
  assert.match(pin.body.message, /PIN code/i);
  assert.equal((await patch('', { phone: '12345' })).status, 400);
  assert.equal((await patch('', { email: 'not-an-email' })).status, 400);
  assert.equal((await patch('', { name: '' })).status, 400);
  const ok = await patch('', { phone: '9000000079', email: 'hello@store.in', address: { street: '1 Road', city: 'Pune', state: 'MH', pincode: '' } });
  assert.equal(ok.status, 200);
  const fine = await patch('', { address: { street: '1 Road', city: 'Pune', state: 'MH', pincode: '411045' } });
  assert.equal(fine.status, 200);
});

test('business settings: a changed PAN or entity type must be valid; unchanged old values never block a save', async () => {
  const pan = await patch('', { settings: { panNumber: 'BADPAN' } });
  assert.equal(pan.status, 400);
  const entity = await patch('', { settings: { legalEntityType: 'Banana Ltd' } });
  assert.equal(entity.status, 400);
  assert.equal((await patch('', { settings: { panNumber: 'ABCDE1234F' } })).status, 200);
  // A store already holding a bad value (saved before these checks) can still save other edits.
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'settings.panNumber': 'OLDBAD' } });
  const other = await patch('', { settings: { panNumber: 'OLDBAD', ownerName: 'New Owner' } });
  assert.equal(other.status, 200);
});

test('a removed store leaves the list and its counts, and is still found under status=removed', async () => {
  const list = async (q = '') => (await srv.request('GET', `/api/admin/stores${q}`, { headers: admin })).body.data;
  assert.equal((await list()).total, 1);
  assert.equal((await srv.request('DELETE', `/api/admin/stores/${restaurant._id}`, { headers: admin })).status, 200);
  const after = await list();
  assert.equal(after.total, 0);
  assert.equal(after.statusCounts.active, 0);
  assert.equal(after.statusCounts.removed, 1);
  const removed = await list('?status=removed');
  assert.deepEqual(removed.stores.map((s) => String(s._id)), [String(restaurant._id)]);
});

test('admin actions never stamp ownerEditedAt; the owner editing their store does', async () => {
  await patch('', { delivery: { radiusKm: 4 } });
  assert.equal((await Restaurant.findById(restaurant._id).lean()).ownerEditedAt, undefined);
});

test('a store saved with an old-format pincode or phone can still have other fields edited', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'address.pincode': '411 045', phone: '+91 98765 43210' } });
  const res = await patch('', { name: 'Renamed', phone: '+91 98765 43210', address: { street: '1 Road', city: 'Pune', state: 'MH', pincode: '411 045' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // …but changing it to another bad value is still refused.
  assert.equal((await patch('', { address: { street: '1 Road', city: 'Pune', state: 'MH', pincode: '41104' } })).status, 400);
});
