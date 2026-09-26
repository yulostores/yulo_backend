// Contract tests for the restaurant's order-approval gate.
//
// Datastore-free (the suite has no Mongo), so these pin the rules rather than the flow:
//
//   * a 'placed' order has exactly two exits — accepted ('confirmed') or rejected
//     ('cancelled'). The old 'placed' -> 'preparing' shortcut let the kitchen start an order
//     the restaurant had never accepted.
//   * the chef/waiter guard refuses a 'placed' order and lets everything else through.
//   * the rejection reasons served to the owner portal exist and are non-empty.

// First on purpose: fills in the env vars config/env.js demands at import time.
import '../test-utils/appHarness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALID_TRANSITIONS,
  assertNotAwaitingApproval,
  ORDER_AWAITING_APPROVAL,
} from '../services/kitchen.service.js';
import { REJECTION_REASONS } from '../services/orderApproval.service.js';

test("a 'placed' order can only be accepted or rejected", () => {
  assert.deepEqual([...VALID_TRANSITIONS.placed].sort(), ['cancelled', 'confirmed']);
});

test('nothing transitions back into placed', () => {
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    assert.ok(!targets.includes('placed'), `${from} -> placed must not be allowed`);
  }
});

test('the staff guard blocks only orders awaiting approval', () => {
  assert.throws(() => assertNotAwaitingApproval({ status: 'placed' }), { code: ORDER_AWAITING_APPROVAL });
  for (const status of ['confirmed', 'preparing', 'ready', 'served', 'delivered', 'cancelled']) {
    assert.doesNotThrow(() => assertNotAwaitingApproval({ status }));
  }
});

test('rejection reasons are offered to the owner portal', () => {
  assert.ok(REJECTION_REASONS.length > 0);
  for (const reason of REJECTION_REASONS) assert.ok(reason.trim().length >= 3);
});
