// A table whose guest is paying online (session `bill_requested`) stays on the waiter's floor
// — the waiter must be able to release that payment or settle at the counter — and never
// gets a second sitting opened alongside it (by the waiter scanning, or another guest
// ordering). In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateStaffToken } = await import('../services/auth.service.js');
const { placeGuestOrder, getGuestSession } = await import('../services/guestOrder.service.js');
const { scanTable } = await import('../services/waiter.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');

let mongo;
let srv;
let restaurant;
let table;
let waiter;
let thali;
let paying;

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
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    isActive: true,
    approvalStatus: 'active',
  });
  table = await Table.create({ restaurantId: restaurant._id, identifier: 'T2' });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Thalis' });
  thali = await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Thali', foodType: 'veg', sellingPrice: 300 });
  waiter = await StaffMember.create({ restaurantId: restaurant._id, staffCode: 'W01', name: 'Waiter', role: 'waiter', phone: '9000000002' });
  paying = await TableSession.create({ restaurantId: restaurant._id, tableId: table._id, status: 'bill_requested' });
});

const waiterHeaders = () => ({ authorization: `Bearer ${generateStaffToken(waiter._id, 'waiter', restaurant._id, 0)}` });

test('a table being paid online stays on the waiter floor and in the open sessions list', async () => {
  const tables = await srv.get(`/api/staff/${restaurant._id}/waiter/tables`, waiterHeaders());
  assert.equal(tables.status, 200, JSON.stringify(tables.body));
  const row = tables.body.data.tables.find((t) => String(t._id) === String(table._id));
  assert.equal(String(row.session?._id), String(paying._id));
  assert.equal(row.session.status, 'bill_requested');

  const sessions = await srv.get(`/api/staff/${restaurant._id}/waiter/sessions`, waiterHeaders());
  assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
  assert.ok(sessions.body.data.sessions.some((s) => String(s._id) === String(paying._id)));

  assert.equal(String((await getGuestSession({ restaurantId: restaurant._id, tableId: table._id }))._id), String(paying._id));
});

test('no second sitting while the bill is being paid: the waiter scan returns it, a guest order is refused', async () => {
  const { session } = await scanTable({ restaurantId: restaurant._id, qrToken: String(table._id), staffId: waiter._id });
  assert.equal(String(session._id), String(paying._id));

  await assert.rejects(
    placeGuestOrder({
      restaurantId: restaurant._id,
      tableId: table._id,
      items: [{ menuItemId: thali._id, quantity: 1 }],
      guestName: 'Asha',
    }),
    (e) => e.code === 'PAYMENT_IN_PROGRESS' && e.statusCode === 409
  );
  assert.equal(await TableSession.countDocuments({ tableId: table._id }), 1);
});
