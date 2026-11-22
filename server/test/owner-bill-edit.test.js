// The owner generates a served table's bill, lowers or removes dishes, and sets a discount —
// all before payment; nothing changes once it is paid. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let seed;
let session;
let round1;
let round2;
let auth;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  seed = await seedBasics();
  auth = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  const table = await Table.create({ restaurantId: seed.restaurant._id, identifier: '7' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const base = { restaurantId: seed.restaurant._id, tableSessionId: session._id, tableId: table._id, type: 'dine_in', placedBy: 'guest' };
  round1 = await Order.create({
    ...base,
    items: [
      { menuItemId: seed.dish._id, name: 'Thali', price: 300, quantity: 2 },
      { menuItemId: seed.dish._id, name: 'Lassi', price: 80, quantity: 1 },
    ],
    subtotal: 680,
    status: 'served',
  });
  round2 = await Order.create({ ...base, items: [{ menuItemId: seed.dish._id, name: 'Roti', price: 20, quantity: 3 }], subtotal: 60, status: 'preparing' });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: { $each: [round1._id, round2._id] } } });
});

const url = (p) => `/api/owner/${seed.restaurant._id}/bills${p}`;

test('open tables → generate once every round is served', async () => {
  const tables = await srv.get(url('/open-tables'), auth);
  assert.equal(tables.status, 200, JSON.stringify(tables.body));
  assert.equal(tables.body.data.tables[0].table, '7');
  assert.equal(tables.body.data.tables[0].allServed, false);

  const early = await srv.request('POST', url(`/sessions/${session._id}/generate`), { headers: auth });
  assert.equal(early.status, 409, 'a round is still in the kitchen');

  await Order.updateOne({ _id: round2._id }, { $set: { status: 'served' } });
  const gen = await srv.request('POST', url(`/sessions/${session._id}/generate`), { headers: auth });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  assert.equal(gen.body.data.bill.charges.subtotal, 740);
});

test('lower a quantity, remove a dish, set and clear a discount — then paid bills are locked', async () => {
  await Order.updateOne({ _id: round2._id }, { $set: { status: 'served' } });
  const billId = (await srv.request('POST', url(`/sessions/${session._id}/generate`), { headers: auth })).body.data.bill._id;
  const edit = (body) => srv.request('PATCH', url(`/${billId}/items`), { headers: auth, body });

  const up = await edit({ orderId: String(round1._id), lineIndex: 0, quantity: 3 });
  assert.equal(up.status, 400, 'raising a quantity is a new order, not an edit');

  let res = await edit({ orderId: String(round1._id), lineIndex: 0, quantity: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.bill.charges.subtotal, 440); // 300 + 80 + 60

  res = await edit({ orderId: String(round2._id), lineIndex: 0, quantity: 0 });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.bill.charges.subtotal, 380);
  assert.equal((await Order.findById(round2._id).lean()).status, 'cancelled', 'an emptied round is cancelled');

  res = await srv.request('PUT', url(`/${billId}/discount`), { headers: auth, body: { type: 'percent', value: 10 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const discount = res.body.data.bill.discountsApplied.find((d) => d.manual);
  assert.equal(discount.amount, 38);
  assert.equal(discount.description, 'Restaurant discount (10%)');

  // A % discount follows the subtotal when a dish goes.
  res = await edit({ orderId: String(round1._id), lineIndex: 1, quantity: 0 });
  assert.equal(res.body.data.bill.discountsApplied.find((d) => d.manual).amount, 30);
  assert.deepEqual(
    res.body.data.bill.adjustments.map((a) => [a.kind, a.itemName ?? a.discount, a.fromQty ?? null, a.toQty ?? null]),
    [
      ['quantity', 'Thali', 2, 1],
      ['quantity', 'Roti', 3, 0],
      ['discount', '10%', null, null],
      ['quantity', 'Lassi', 1, 0],
    ]
  );

  res = await srv.request('PUT', url(`/${billId}/discount`), { headers: auth, body: { type: 'flat', value: 0 } });
  assert.equal(res.body.data.bill.discountsApplied.some((d) => d.manual), false);

  const paid = await srv.request('POST', url(`/${billId}/mark-paid`), { headers: auth, body: { method: 'cash' } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal((await edit({ orderId: String(round1._id), lineIndex: 0, quantity: 0 })).status, 409);
});

test('the fixed service charge comes off one bill and goes back on', async () => {
  const { default: Restaurant } = await import('../models/Restaurant.js');
  await Restaurant.updateOne({ _id: seed.restaurant._id }, { $set: { 'settings.serviceChargeAmount': 40 } });
  await Order.updateOne({ _id: round2._id }, { $set: { status: 'served' } });
  let bill = (await srv.request('POST', url(`/sessions/${session._id}/generate`), { headers: auth })).body.data.bill;
  assert.equal(bill.charges.serviceChargeAmount, 40);

  let res = await srv.request('PUT', url(`/${bill._id}/service-charge`), { headers: auth, body: { enabled: false } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.bill.charges.serviceChargeAmount, 0);
  assert.equal(res.body.data.bill.serviceChargeRemoved, true);
  // Still off after the bill is re-read (re-assembled).
  bill = (await srv.request('POST', url(`/sessions/${session._id}/generate`), { headers: auth })).body.data.bill;
  assert.equal(bill.charges.serviceChargeAmount, 0);

  res = await srv.request('PUT', url(`/${bill._id}/service-charge`), { headers: auth, body: { enabled: true } });
  assert.equal(res.body.data.bill.charges.serviceChargeAmount, 40);
});
