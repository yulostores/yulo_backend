// Live activity overhead check (AT). Not a test (node --test doesn't run test-utils/); run by hand:
//   node --import ./test-utils/testEnv.mjs test-utils/liveOverhead.bench.mjs
// Times 200 POST /api/cart/items with the feature off and 200 with it on — interleaved in
// batches so warm-up and drift hit both equally — against the in-memory MongoDB, and counts the
// database operations one tracked request adds. Recording runs after the response, so the
// customer-facing latency should barely move.

import mongoose from 'mongoose';
import { startMemoryMongo } from './memoryMongo.mjs';

const mongo = await startMemoryMongo();
const { startTestServer } = await import('./appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const activity = await import('../services/activity.service.js');
const { authHeader, makeCustomer, makeRestaurant } = await import('./liveFixtures.mjs');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
await Promise.all([CustomerSession.init(), ActivityEvent.init()]);

const srv = await startTestServer({ withSocket: true });
activity.__setRedisForTests(null);
const { paneer } = await makeRestaurant();
const customer = await makeCustomer();
const headers = authHeader(customer);

const add = async () => {
  const started = process.hrtime.bigint();
  const res = await srv.request('POST', '/api/cart/items', { headers, body: { menuItemId: String(paneer._id), qty: 1 } });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return ms;
};
const setFlag = (enabled) => live.__setLiveActivityForTests({ enabled, restaurantIds: '' });

// Warm-up (both paths), not measured.
for (const enabled of [false, true]) {
  setFlag(enabled);
  for (let i = 0; i < 20; i += 1) await add();
  await activity.__flushForTests();
}

const samples = { off: [], on: [] };
for (let batch = 0; batch < 10; batch += 1) {
  for (const enabled of batch % 2 ? [true, false] : [false, true]) {
    setFlag(enabled);
    for (let i = 0; i < 20; i += 1) samples[enabled ? 'on' : 'off'].push(await add());
    await activity.__flushForTests();
  }
}

// Database operations for one request, flag off vs on (recording included).
const opsFor = async (enabled) => {
  setFlag(enabled);
  const ops = [];
  mongoose.set('debug', (collection, method) => ops.push(`${collection}.${method}`));
  await add();
  await activity.__flushForTests();
  mongoose.set('debug', false);
  return ops;
};
const opsOff = await opsFor(false);
const opsOn = await opsFor(true);
const extra = [...opsOn];
for (const op of opsOff) extra.splice(extra.indexOf(op), 1);
const WRITE = /insert|update|findOneAndUpdate|delete|bulkWrite|save|create/i;

const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, median: at(0.5), p95: at(0.95) };
};
const off = stats(samples.off);
const on = stats(samples.on);
const fmt = (x) => x.toFixed(2);
console.log(`POST /api/cart/items, in-memory MongoDB, no Redis, ${off.n} + ${on.n} requests`);
console.log(`  flag off: median ${fmt(off.median)} ms, p95 ${fmt(off.p95)} ms`);
console.log(`  flag on:  median ${fmt(on.median)} ms, p95 ${fmt(on.p95)} ms`);
console.log(`  difference: median ${fmt(on.median - off.median)} ms, p95 ${fmt(on.p95 - off.p95)} ms`);
console.log(`  DB operations added by one tracked request (after the response): ${extra.length}`);
console.log(`    writes: ${extra.filter((op) => WRITE.test(op)).join(', ')}`);
console.log(`    reads:  ${extra.filter((op) => !WRITE.test(op)).join(', ')}`);

await srv.close();
await mongo.stop();
process.exit(0);
