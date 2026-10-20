// B1 — production: ALLOW_PAYMENT_SIMULATION=true is ignored. Both simulate endpoints answer
// 404 and the app config says simulation is off.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  seedBasics,
  createPendingOnlineOrder,
} from '../test-utils/paymentFixtures.mjs';

process.env.NODE_ENV = 'production';
process.env.ALLOW_PAYMENT_SIMULATION = 'true';
useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');

let mongo;
let srv;
let seed;

before(async () => {
  mongo = await startMemoryMongo();
  __setRazorpayForTests(createFakeRazorpay());
  srv = await startTestServer({ withSocket: true });
  seed = await seedBasics();
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

test('order simulate → 404 in production even with the flag set', async () => {
  const order = await createPendingOnlineOrder(seed);
  const res = await srv.request('POST', `/api/orders/${order._id}/payment/simulate`, {
    headers: { authorization: `Bearer ${seed.customerToken}` },
  });
  assert.equal(res.status, 404);
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'pending');
});

test('public bill simulate → 404 in production, bill stays open', async () => {
  const table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T9' });
  const session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const bill = await Bill.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    subtotal: 300,
    grandTotal: 327,
  });

  const res = await srv.request(
    'POST',
    `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill/pay/simulate`
  );
  assert.equal(res.status, 404);
  assert.equal((await Bill.findById(bill._id).lean()).status, 'open');
});

test('app config reports simulation off in production', async () => {
  const res = await srv.get('/api/app/config');
  assert.equal(res.body.data.config.payments.paymentSimulationEnabled, false);
});
