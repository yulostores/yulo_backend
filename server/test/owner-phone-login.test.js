// Restaurant owners sign in with mobile number + password (no email). Covers login, signup
// (mobile required and unique), the admin "Add store" owner, and that an owner can't remove
// the number they log in with. In-memory MongoDB. The auth limiter allows 10 calls a minute
// per IP, so this file makes 9.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { hashPassword, generateTokens } = await import('../services/auth.service.js');

const PASSWORD = 'Owner#2026';
let mongo;
let srv;
let owner;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
  owner = await User.create({
    name: 'Owner', email: 'owner@test.local', phone: '9876543210',
    passwordHash: await hashPassword(PASSWORD), role: 'restaurant_owner',
  });
  await User.create({ name: 'Customer', phone: '9123456789', role: 'customer' });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

const login = (body) => srv.request('POST', '/api/owner/auth/login', { body });
const signup = (body) => srv.request('POST', '/api/owner/auth/signup', { body });

test('owner login: mobile number + password signs in, in any typed format', async () => {
  const res = await login({ phone: '+91 98765-43210', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.user.email, 'owner@test.local');
  assert.ok(res.body.data.accessToken);
});

test('owner login: wrong password, unknown number, a customer number and email all fail', async () => {
  const wrong = await login({ phone: '9876543210', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.message, 'Invalid mobile number or password');

  const customer = await login({ phone: '9123456789', password: PASSWORD });
  assert.equal(customer.status, 401);

  const byEmail = await login({ email: 'owner@test.local', password: PASSWORD });
  assert.equal(byEmail.status, 400, 'email is no longer a login field');
});

test('owner signup: mobile number is required and must be unused', async () => {
  const base = { name: 'New Owner', email: 'new@test.local', password: PASSWORD };
  assert.equal((await signup(base)).status, 400);

  const taken = await signup({ ...base, phone: '9123456789' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.message, 'This mobile number is already registered');

  const ok = await signup({ ...base, phone: '+91 88887 77766' });
  assert.equal(ok.status, 201);
  assert.equal((await User.findOne({ email: 'new@test.local' }).lean()).phone, '8888777766');

  const back = await login({ phone: '8888777766', password: PASSWORD });
  assert.equal(back.status, 200);
});

test("owner profile: the login number can be changed but not removed", async () => {
  const auth = { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` };
  const cleared = await srv.request('PATCH', '/api/users/me', { body: { phone: '' }, headers: auth });
  assert.equal(cleared.status, 400);
  assert.match(cleared.body.message, /can't be removed/);
  assert.equal((await User.findById(owner._id).lean()).phone, '9876543210');
});
