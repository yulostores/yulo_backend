// Staff sign in with phone + a 4-digit PIN the owner sets, views and changes in Staff
// Management (no email, no OTP). In-memory MongoDB.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let restaurant;
let ownerAuth;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
  const owner = await User.create({ name: 'Owner', email: 'pin@test.local', phone: '9876533333', role: 'restaurant_owner' });
  ownerAuth = { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` };
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Pin Cafe',
    location: { type: 'Point', coordinates: [73.84, 18.52] },
    approvalStatus: 'active',
    isActive: true,
  });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

const staffUrl = (path = '') => `/api/owner/${restaurant._id}/staff${path}`;
const login = (phone, pin) =>
  srv.request('POST', '/api/staff/auth/login', { body: { restaurantId: String(restaurant._id), phone, pin } });

test('owner adds a waiter with phone + PIN, sees the PIN, the waiter signs in with it', async () => {
  const noPin = await srv.request('POST', staffUrl(), { headers: ownerAuth, body: { name: 'Ravi', role: 'waiter', phone: '9123400001' } });
  assert.equal(noPin.status, 400, 'a PIN is required');

  const created = await srv.request('POST', staffUrl(), {
    headers: ownerAuth,
    body: { name: 'Ravi', role: 'waiter', phone: '+91 91234 00001', pin: '4821' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.staff.pin, '4821');
  assert.equal(created.body.data.staff.pinHash, undefined);
  assert.equal(created.body.data.staff.pinEncrypted, undefined);
  assert.equal(created.body.data.staff.email, undefined);

  const list = await srv.get(staffUrl(), ownerAuth);
  assert.equal(list.body.data.staff[0].pin, '4821');

  const ok = await login('9123400001', '4821');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.data.staffToken);
  assert.equal(ok.body.data.staff.name, 'Ravi');

  const wrong = await login('9123400001', '0000');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.message, 'Wrong phone number or PIN');
  const stranger = await login('9123400999', '4821');
  assert.equal(stranger.status, 401);
  assert.equal(stranger.body.message, 'Wrong phone number or PIN');
});

test('changing the PIN signs the member out and only the new PIN works', async () => {
  const member = await StaffMember.findOne({ phone: '9123400001' }).lean();
  const changed = await srv.request('PATCH', staffUrl(`/${member._id}`), { headers: ownerAuth, body: { pin: '7310' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.data.staff.pin, '7310');
  const after = await StaffMember.findById(member._id).lean();
  assert.equal(after.sessionVersion, (member.sessionVersion ?? 0) + 1);
  assert.equal((await login('9123400001', '4821')).status, 401);
  assert.equal((await login('9123400001', '7310')).status, 200);
});

test('a member from before PINs is told to ask for one; the OTP login is gone', async () => {
  await StaffMember.create({ restaurantId: restaurant._id, staffCode: 'C09', name: 'Old Chef', role: 'chef', phone: '9123400002' });
  const res = await login('9123400002', '1234');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'PIN_NOT_SET');
  const list = await srv.get(staffUrl(), ownerAuth);
  assert.equal(list.body.data.staff.find((s) => s.name === 'Old Chef').pin, null);

  const otp = await srv.request('POST', '/api/staff/auth/otp/send', { body: { restaurantId: String(restaurant._id), phone: '9123400002' } });
  assert.equal(otp.status, 404);
});
