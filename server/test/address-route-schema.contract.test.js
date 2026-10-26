// The route-level zod schemas for POST/PATCH /users/me/addresses. middleware/validate.js
// replaces req.body with the parsed result, so a field missing from these schemas never
// reaches services/address.service.js — the flat number, floor, landmark etc. the app sends
// were being silently dropped here.

// First on purpose: fills in the env vars config/env.js demands at import time.
import '../test-utils/appHarness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressCreateSchema, addressUpdateSchema } from '../routes/user.routes.js';

const details = {
  houseNumber: 'Flat 4B',
  floor: '2',
  building: 'Green Towers',
  landmark: 'Near City Mall',
  area: 'Lalpur',
  country: 'India',
  formattedAddress: 'Main Road, Lalpur, Ranchi',
};

test('address create schema keeps the structured detail fields', () => {
  const out = addressCreateSchema.parse({ label: 'home', street: 'Main Road', city: 'Ranchi', ...details });
  for (const [k, v] of Object.entries(details)) assert.equal(out[k], v, k);
});

test('address update schema keeps the structured detail fields', () => {
  const out = addressUpdateSchema.parse(details);
  for (const [k, v] of Object.entries(details)) assert.equal(out[k], v, k);
  assert.equal(addressUpdateSchema.parse({ houseNumber: null }).houseNumber, null);
});

test('address detail fields are length-limited', () => {
  assert.equal(addressUpdateSchema.safeParse({ houseNumber: 'x'.repeat(121) }).success, false);
  assert.equal(addressCreateSchema.safeParse({ city: 'Ranchi', formattedAddress: 'x'.repeat(401) }).success, false);
});
