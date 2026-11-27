// CB8 — team management (who may add, edit and remove whom; sign-out on removal and role change;
// never without an owner), the partner agreement (versioned acceptance) and the business profile
// (masked, contact fields only). In-memory MongoDB, in-memory Redis stand-in; through HTTP.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller, sellerHeaders, VALID } = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const team = await import('../services/sellerTeam.service.js');
const { __resetCouponSettingsCache, createCouponSettingsVersion } = await import('../services/couponSettings.service.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: Seller } = await import('../models/Seller.js');

const redis = fakeRedis();
let mongo;
let srv;
let shop;
let manager;
let employee;

before(async () => {
  mongo = await startMemoryMongo();
  await SellerUser.init();
  auth.__setAuthRedisForTests(redis);
  srv = await startTestServer();
});
after(async () => {
  auth.__setAuthRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  redis.clear();
  __resetCouponSettingsCache();
  const category = await makeCategory({ key: 'salon', name: 'Salon' });
  shop = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000001' });
  manager = await member('manager', 'Meera Nair', '9700000001');
  employee = await member('employee', 'Ravi Kumar', '9700000002');
});

const member = async (role, name, phone, sellerId = shop.seller._id) => {
  const user = await SellerUser.create({ sellerId, name, phone, role });
  return { user, headers: sellerHeaders(user) };
};

const call = (method, path, body, headers = shop.headers) => srv.request(method, `/api/seller${path}`, { body, headers });
const users = (method, path = '', body, headers) => call(method, `/users${path}`, body, headers);

// ── Team ──────────────────────────────────────────────────────────────────────

test('the team list: owners first, who each viewer may manage', async () => {
  const asOwner = await users('GET', '', undefined, shop.headers);
  assert.equal(asOwner.status, 200);
  const rows = asOwner.body.data.members;
  assert.deepEqual(rows.map((m) => [m.role, m.name, m.isYou, m.canManage]), [
    ['owner', 'Asha Rao', true, false],
    ['manager', 'Meera Nair', false, true],
    ['employee', 'Ravi Kumar', false, true],
  ]);
  assert.deepEqual(asOwner.body.data.manageableRoles, ['owner', 'manager', 'employee']);

  const asManager = (await users('GET', '', undefined, manager.headers)).body.data;
  assert.deepEqual(asManager.members.map((m) => m.canManage), [false, false, true]);
  assert.deepEqual(asManager.manageableRoles, ['employee']);
  assert.ok(!JSON.stringify(asOwner.body).includes('passwordHash'));
});

test('owner adds managers and employees; duplicate numbers and bad input refused; the new login works at once', async () => {
  const added = await users('POST', '', { name: 'Sana Khan', phone: '+91 97000 00003', role: 'manager', gender: 'female' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.data.member.phone, '9700000003', 'normalised');
  assert.equal(added.body.data.member.isActive, true);
  const row = await SellerUser.findById(added.body.data.member._id);
  assert.equal((await call('GET', '/dashboard', undefined, sellerHeaders(row))).status, 200, 'a manager now');

  const dup = await users('POST', '', { name: 'Someone', phone: '9700000002', role: 'employee' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'DUPLICATE_PHONE');
  for (const body of [
    { name: 'A', phone: '9700000004', role: 'employee' },
    { name: 'Good Name', phone: '12345', role: 'employee' },
    { name: 'Good Name', phone: '9700000004', role: 'boss' },
    { name: 'Good Name', phone: '9700000004', role: 'employee', dateOfBirth: '2020-01-01' },
    { name: 'Good Name', phone: '9700000004', role: 'employee', sellerId: String(new mongoose.Types.ObjectId()) },
  ]) {
    assert.equal((await users('POST', '', body)).status, 400, JSON.stringify(body));
  }
  // Two adds of the same new number at once: one wins.
  const both = await Promise.all([1, 2].map(() => users('POST', '', { name: 'Twin One', phone: '9700000005', role: 'employee' })));
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
});

test('a manager manages employees only: add / edit / remove an employee, nothing else', async () => {
  const h = manager.headers;
  const added = await users('POST', '', { name: 'New Hire', phone: '9700000010', role: 'employee' }, h);
  assert.equal(added.status, 201);
  assert.equal((await users('PATCH', `/${employee.user._id}`, { name: 'Ravi K' }, h)).status, 200);
  assert.equal((await SellerUser.findById(employee.user._id).lean()).name, 'Ravi K');

  const refused = [
    ['POST', '', { name: 'Boss Two', phone: '9700000011', role: 'manager' }],
    ['POST', '', { name: 'Boss Two', phone: '9700000011', role: 'owner' }],
    ['PATCH', `/${employee.user._id}`, { role: 'manager' }],
    ['PATCH', `/${shop.owner._id}`, { name: 'Changed' }],
    ['DELETE', `/${shop.owner._id}`],
    ['PATCH', `/${manager.user._id}`, { name: 'Me' }],
    ['DELETE', `/${manager.user._id}`],
  ];
  for (const [method, path, body] of refused) {
    const res = await users(method, path, body, h);
    assert.equal(res.status, 403, `${method} ${path} ${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await users('DELETE', `/${added.body.data.member._id}`, undefined, h)).status, 200);
});

test('owner edits roles and removes anyone but themselves; removal and role change end sessions', async () => {
  const oldEmployeeHeaders = employee.headers;
  const promoted = await users('PATCH', `/${employee.user._id}`, { role: 'manager' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.data.member.role, 'manager');
  assert.equal((await call('GET', '/redeem/today', undefined, oldEmployeeHeaders)).status, 401, 'old session ended');
  const fresh = await SellerUser.findById(employee.user._id);
  assert.equal((await call('GET', '/dashboard', undefined, sellerHeaders(fresh))).status, 200, 'signs in again as a manager');

  const managerHeaders = manager.headers;
  const removed = await users('DELETE', `/${manager.user._id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.member.isActive, false);
  assert.equal((await call('GET', '/dashboard', undefined, managerHeaders)).status, 401);
  assert.equal((await users('DELETE', `/${manager.user._id}`)).status, 404, 'already removed');
  assert.ok(!(await users('GET')).body.data.members.some((m) => m.name === 'Meera Nair'));

  // Removed people can be added back on the same number.
  assert.equal((await users('POST', '', { name: 'Meera Nair', phone: '9700000001', role: 'employee' })).status, 201);

  for (const [method, body] of [['PATCH', { role: 'employee' }], ['PATCH', { name: 'Me' }], ['DELETE']]) {
    const res = await users(method, `/${shop.owner._id}`, body);
    assert.equal(res.status, 403, `self ${method}`);
  }
  assert.equal((await users('PATCH', '/not-an-id', { name: 'Valid Name' })).status, 404);
  assert.equal((await users('PATCH', `/${employee.user._id}`, {})).status, 400);
  assert.equal((await users('PATCH', `/${employee.user._id}`, { phone: '9700000099' })).status, 400, 'the phone is the login');
});

test('owners: a second owner can be added and removed; the last active owner can never go', async () => {
  const second = await users('POST', '', { name: 'Co Owner', phone: '9700000020', role: 'owner' });
  assert.equal(second.status, 201);
  const secondUser = await SellerUser.findById(second.body.data.member._id);
  // The co-owner demotes the original owner, then the original is the one who can't act on them.
  assert.equal((await users('PATCH', `/${shop.owner._id}`, { role: 'manager' }, sellerHeaders(secondUser))).status, 200);
  assert.equal((await users('DELETE', `/${secondUser._id}`, undefined, shop.headers)).status, 401, 'demoted: signed out');

  // The service refuses to leave the business ownerless even for a caller the routes would never
  // let through (e.g. an owner row deactivated while their request was in flight).
  const ghost = { sellerId: shop.seller._id, userId: new mongoose.Types.ObjectId(), role: 'owner' };
  await assert.rejects(team.removeMember(ghost, secondUser._id), (err) => err.code === 'LAST_OWNER');
  await assert.rejects(team.editMember(ghost, secondUser._id, { role: 'manager' }), (err) => err.code === 'LAST_OWNER');
  assert.equal((await SellerUser.findById(secondUser._id).lean()).isActive, true);
});

test("team ids of another business are not found; a pending seller manages its team through onboarding", async () => {
  const other = await makeCompleteSeller({ status: 'active', categoryId: shop.seller.categoryId, phone: '9600000002' });
  const theirs = await member('employee', 'Their Person', '9700000030', other.seller._id);
  for (const [method, body] of [['PATCH', { name: 'Hijack' }], ['DELETE']]) {
    assert.equal((await users(method, `/${theirs.user._id}`, body)).status, 404);
  }
  assert.equal((await SellerUser.findById(theirs.user._id).lean()).isActive, true);

  const pending = await makeCompleteSeller({ status: 'pending', categoryId: shop.seller.categoryId, phone: '9600000003' });
  const res = await users('GET', '', undefined, pending.headers);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'SELLER_NOT_ACTIVE');
});

// ── Agreement ─────────────────────────────────────────────────────────────────

const publish = (version, text) =>
  createCouponSettingsVersion({ patch: { agreementVersion: version, agreementText: text } }, new mongoose.Types.ObjectId()).then(() =>
    __resetCouponSettingsCache()
  );

test('agreement: nothing to accept until published; accept records version, time, user and IP; a new version needs a new acceptance', async () => {
  const none = await call('GET', '/agreement');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.data.agreement, { published: false, version: 0, scope: 'general', categoryName: null, text: '', acceptance: null, upToDate: false });
  const early = await call('POST', '/agreement/accept', { version: 1 });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'NO_AGREEMENT');

  await publish(1, 'Partner terms v1');
  assert.equal((await call('GET', '/agreement', undefined, manager.headers)).status, 403, 'managers do not see the agreement');
  const v1 = (await call('GET', '/agreement')).body.data.agreement;
  assert.equal(v1.text, 'Partner terms v1');
  assert.equal(v1.upToDate, false);
  assert.equal((await call('POST', '/agreement/accept', { version: 1 }, manager.headers)).status, 403, 'owner only');

  const accepted = await call('POST', '/agreement/accept', { version: 1 });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.agreement.upToDate, true);
  assert.equal(accepted.body.data.agreement.acceptance.version, 1);
  assert.equal(accepted.body.data.agreement.acceptance.acceptedByName, 'Asha Rao');
  assert.ok(!('ip' in accepted.body.data.agreement.acceptance), 'the IP is recorded, not shown');
  const stored = (await Seller.findById(shop.seller._id).lean()).agreement;
  assert.equal(stored.version, 1);
  assert.equal(String(stored.acceptedBy), String(shop.owner._id));
  assert.ok(stored.ip);
  const firstAt = stored.acceptedAt.getTime();

  // Accepting the same version again keeps the first acceptance.
  await call('POST', '/agreement/accept', { version: 1 });
  assert.equal((await Seller.findById(shop.seller._id).lean()).agreement.acceptedAt.getTime(), firstAt);

  await publish(2, 'Partner terms v2');
  const v2 = (await call('GET', '/agreement')).body.data.agreement;
  assert.equal(v2.upToDate, false);
  assert.equal(v2.acceptance.version, 1);
  const stale = await call('POST', '/agreement/accept', { version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'AGREEMENT_CHANGED');
  assert.equal(stale.body.details.currentVersion, 2);
  assert.equal((await call('POST', '/agreement/accept', { version: 2 })).body.data.agreement.upToDate, true);
  assert.equal((await call('POST', '/agreement/accept', { version: 'two' })).status, 400);

  // An owner still in onboarding can accept too.
  const pending = await makeCompleteSeller({ status: 'pending', categoryId: shop.seller.categoryId, phone: '9600000004' });
  assert.equal((await call('POST', '/agreement/accept', { version: 2 }, pending.headers)).status, 200);
});

// ── Profile ───────────────────────────────────────────────────────────────────

test('profile: identity numbers masked; only phone, address and map pin can change; owner only', async () => {
  const res = await call('GET', '/profile', undefined, manager.headers);
  assert.equal(res.status, 200);
  const p = res.body.data.profile;
  assert.equal(p.businessName, 'Glow Salon');
  assert.equal(p.owner.panMasked, `******${VALID.pan.slice(-4)}`);
  assert.equal(p.owner.aadhaarMasked, `XXXX XXXX ${VALID.aadhaar.slice(-4)}`);
  assert.ok(!JSON.stringify(res.body).includes(VALID.pan), 'no full PAN');
  assert.ok(!/panEncrypted|aadhaarEncrypted/.test(JSON.stringify(res.body)));
  assert.deepEqual(p.editableFields, ['businessPhone', 'address', 'location']);

  const ok = await call('PATCH', '/profile', {
    businessPhone: '9822222222',
    address: { line1: '14 Brigade Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560025' },
    location: { lat: 12.97, lng: 77.6 },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.profile.businessPhone, '9822222222');
  assert.deepEqual(ok.body.data.profile.location, { lng: 77.6, lat: 12.97 });

  const locked = await call('PATCH', '/profile', { businessName: 'New Name', businessPhone: '9833333333' });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'PROFILE_LOCKED');
  assert.deepEqual(locked.body.details.lockedFields, ['businessName']);
  assert.equal((await Seller.findById(shop.seller._id).lean()).businessPhone, '9822222222', 'nothing applied');
  assert.equal((await call('PATCH', '/profile', { businessPhone: '123' })).status, 400);
  assert.equal((await call('PATCH', '/profile', {})).status, 400);
  assert.equal((await call('PATCH', '/profile', { businessPhone: '9844444444' }, manager.headers)).status, 403);
});
