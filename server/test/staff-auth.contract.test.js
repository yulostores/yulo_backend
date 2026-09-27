// Contract tests for staff (waiter/chef) phone + OTP sign-in.
//
// Datastore-free (the suite has no Mongo), so these pin the rules rather than the flow:
//
//   * the owner types a staff number once and the member types it at every login, so every
//     way of writing the same Indian mobile number must normalise to the same 10 digits —
//     otherwise the login lookup silently misses.
//   * a staff session is exactly 24 hours and carries the member's session version.

// First on purpose: fills in the env vars config/env.js demands at import time.
import '../test-utils/appHarness.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const { normalizeIndianPhone } = await import('../utils/phone.js');
const { generateStaffToken, STAFF_SESSION_SECONDS } = await import('../services/auth.service.js');
const { env } = await import('../config/env.js');

test('every common way of writing a mobile number becomes the same 10 digits', () => {
  for (const input of ['9876543210', '+91 98765 43210', '+919876543210', '919876543210', '09876543210', '98765-43210', ' 98765 43210 ']) {
    assert.equal(normalizeIndianPhone(input), '9876543210', input);
  }
});

test('things that are not an Indian mobile number are rejected', () => {
  for (const input of ['', '12345', '1234567890', '5876543210', '98765432101', '+1 202 555 0147', 'abc', null, undefined, {}]) {
    assert.equal(normalizeIndianPhone(input), null, String(input));
  }
});

test('a staff token lasts exactly 24 hours and carries the session version', () => {
  assert.equal(STAFF_SESSION_SECONDS, 24 * 60 * 60);
  const token = generateStaffToken('64a0000000000000000000aa', 'waiter', '64a0000000000000000000bb', 3);
  const decoded = jwt.verify(token, env.JWT_STAFF_SECRET);
  assert.equal(decoded.exp - decoded.iat, 24 * 60 * 60);
  assert.equal(decoded.sv, 3);
  assert.equal(decoded.role, 'waiter');
  assert.ok(decoded.jti);
});
