// B1 — dev simulation mode (NODE_ENV=development + ALLOW_PAYMENT_SIMULATION=true): the
// simulate endpoints work and the backend never creates Razorpay orders, even with gateway
// keys configured — so a local .env holding real keys can't reach Razorpay.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  seedBasics,
  createPendingOnlineOrder,
  NEARBY_DROP,
} from '../test-utils/paymentFixtures.mjs';

process.env.NODE_ENV = 'development';
process.env.ALLOW_PAYMENT_SIMULATION = 'true';
useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { default: Order } = await import('../models/Order.js');

let mongo;
let srv;
let fake;
let seed;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics();
});

const auth = () => ({ authorization: `Bearer ${seed.customerToken}` });

test('app config reports simulation on', async () => {
  const res = await srv.get('/api/app/config');
  assert.equal(res.body.data.config.payments.paymentSimulationEnabled, true);
});

test('online order in simulation mode: no Razorpay order is created; client told to simulate', async () => {
  const res = await srv.request('POST', '/api/orders', {
    headers: auth(),
    body: {
      restaurantId: String(seed.restaurant._id),
      items: [{ menuItemId: String(seed.dish._id), quantity: 1 }],
      type: 'delivery',
      deliveryAddress: { coordinates: NEARBY_DROP },
      paymentMethod: 'online',
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.paymentSimulated, true);
  assert.equal(res.body.data.razorpayOrder, null);
  assert.equal(fake.calls.ordersCreate.length, 0, 'gateway never touched');

  const sim = await srv.request('POST', `/api/orders/${res.body.data.order._id}/payment/simulate`, {
    headers: auth(),
  });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  const saved = await Order.findById(res.body.data.order._id).lean();
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.paymentChannel, 'online');
});

test('simulate is idempotent and refuses a non-online order', async () => {
  const order = await createPendingOnlineOrder(seed);
  const a = await srv.request('POST', `/api/orders/${order._id}/payment/simulate`, { headers: auth() });
  const b = await srv.request('POST', `/api/orders/${order._id}/payment/simulate`, { headers: auth() });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.data.order.razorpayPaymentId, b.body.data.order.razorpayPaymentId);

  const cash = await createPendingOnlineOrder(seed, { paymentMethod: 'cash', paymentChannel: 'cod' });
  const res = await srv.request('POST', `/api/orders/${cash._id}/payment/simulate`, { headers: auth() });
  assert.equal(res.status, 400);
});
