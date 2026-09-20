// Contract tests for how a customer delivery address is validated, located and composed.
//
// Datastore-free (the suite has no Mongo), so these cover the pure rules — which is where
// every one of the bugs they pin actually lived:
//
//   * a reversed [lat, lng] pair must be REJECTED, not stored. Anywhere in India both
//     halves are individually valid either way round, so per-axis range checks pass a swap
//     straight through and the address is silently several thousand km away forever.
//   * `{ type: 'Point', coordinates: [] }` must never be a storable location. It is truthy
//     and correctly typed, which is why every consumer mistook it for a real point: the
//     customer app read it as `{ latitude: undefined }` and stopped loading the home feed,
//     and computeDropKm turned it into NaN in the rider's distance pay.
//   * editing an address must only re-geocode when a postal part actually CHANGED. The old
//     rule fired on key presence, and the app posts every postal key on every save, so
//     editing the receiver's phone number silently moved the customer's dragged pin.
//   * the composed `street` line must keep carrying the whole address, since orders placed
//     before the structured fields existed — and every screen that prints one string — read
//     only that.

// First on purpose: fills in the env vars config/env.js demands at import time.
import '../test-utils/appHarness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeStreetLine,
  normalizeLocation,
  parseAddressInput,
  postalPartsChanged,
  resolveAddress,
} from '../services/address.service.js';

const at = (coordinates) => ({ type: 'Point', coordinates });
const parse = (body) => parseAddressInput({ label: 'home', city: 'Ranchi', ...body });
const rejects = (body) => assert.throws(() => parse(body), { code: 'VALIDATION_ERROR' });

test('coordinates: GeoJSON [lng, lat] inside India is accepted', () => {
  assert.deepEqual(parse({ location: at([85.3616, 23.9924]) }).location.coordinates, [85.3616, 23.9924]);
  assert.deepEqual(parse({ location: at([77.209, 28.6139]) }).location.coordinates, [77.209, 28.6139]);
});

test('coordinates: a reversed [lat, lng] pair is rejected, not silently stored', () => {
  rejects({ location: at([23.9924, 85.3616]) }); // Ranchi, reversed
  rejects({ location: at([28.6139, 77.209]) }); // Delhi, reversed
  rejects({ location: at([12.9716, 77.5946]) }); // Bengaluru, reversed
});

test('coordinates: the placeholder and malformed pairs are rejected', () => {
  rejects({ location: at([0, 0]) });
  rejects({ location: at([]) });
  rejects({ location: at([85.36]) });
  rejects({ location: at(['85.36', '23.99']) });
  rejects({ location: at([181, 10]) });
});

test('an address with neither a point nor a city/pincode is rejected', () => {
  assert.throws(() => parseAddressInput({ label: 'home' }), { code: 'VALIDATION_ERROR' });
  // Any one of the three is enough.
  assert.ok(parseAddressInput({ label: 'home', city: 'Ranchi' }));
  assert.ok(parseAddressInput({ label: 'home', pincode: '825301' }));
  assert.ok(parseAddressInput({ label: 'home', location: at([85.3616, 23.9924]) }));
});

test('normalizeLocation: only a real point survives; everything else is absent', () => {
  assert.deepEqual(normalizeLocation(at([85.3616, 23.9924])), at([85.3616, 23.9924]));
  assert.equal(normalizeLocation(at([])), undefined, 'the empty-array shape must not survive');
  assert.equal(normalizeLocation(at([0, 0])), undefined);
  assert.equal(normalizeLocation(undefined), undefined);
  assert.equal(normalizeLocation({}), undefined);
});

test('composeStreetLine: the parts read the way an address is read at a door', () => {
  assert.equal(
    composeStreetLine({
      houseNumber: 'B-402',
      building: 'Sunrise Apartments',
      floor: '4',
      landmark: 'Near City Mall',
      street: 'MG Road',
    }),
    'B-402, Sunrise Apartments, Floor 4, Near City Mall, MG Road'
  );
});

test('composeStreetLine: a landmark already in the geocoded street is not repeated', () => {
  assert.equal(composeStreetLine({ houseNumber: 'B-402', landmark: 'MG Road', street: 'mg road' }), 'B-402, MG Road');
});

test('composeStreetLine: nothing to compose stays undefined, never an empty string', () => {
  assert.equal(composeStreetLine({}), undefined);
  assert.equal(composeStreetLine({ houseNumber: '   ' }), undefined);
});

test('postalPartsChanged: only a changed VALUE counts, not a resent key', () => {
  const existing = { street: 'MG Road', city: 'Ranchi', pincode: '834001' };

  // The exact shape the app's edit screen posts when only the receiver changed.
  assert.equal(
    postalPartsChanged(existing, { ...existing, contactPhone: '9876543210' }),
    false,
    'resending unchanged postal fields must not move the pin'
  );
  assert.equal(postalPartsChanged(existing, { city: 'Hazaribagh' }), true);
  assert.equal(postalPartsChanged(existing, { houseNumber: 'B-402' }), true);
  // Whitespace-only differences are not a move.
  assert.equal(postalPartsChanged(existing, { city: ' Ranchi ' }), false);
});

test('resolveAddress: a supplied pin wins and is never re-geocoded', async () => {
  const out = await resolveAddress({}, { houseNumber: 'B-402', city: 'Ranchi', location: at([85.3616, 23.9924]) });
  assert.deepEqual(out.location, at([85.3616, 23.9924]));
  assert.equal(out.locationSource, 'map_pin');
  assert.equal(out.street, 'B-402');
});

test('resolveAddress: geocode:false leaves the stored point alone', async () => {
  const existing = { street: 'MG Road', city: 'Ranchi', location: at([85.3616, 23.9924]) };
  const out = await resolveAddress(existing, { contactPhone: '9876543210' }, { geocode: false });
  assert.equal('location' in out, false, 'an untouched address must not have its point rewritten');
  assert.equal(out.contactPhone, '9876543210');
});

test('resolveAddress: the composed street line survives into the patch', async () => {
  const out = await resolveAddress(
    { city: 'Ranchi' },
    { houseNumber: 'B-402', building: 'Sunrise', landmark: 'Near City Mall', location: at([85.3616, 23.9924]) }
  );
  assert.equal(out.street, 'B-402, Sunrise, Near City Mall');
});
