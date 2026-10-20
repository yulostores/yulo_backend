// B7 — the restaurant's settlement bank account: encryption at rest, the owner add/replace
// flow and its validation, re-verification on any change, the admin masked view / audited
// reveal / verify / reject, owner isolation, and that no other response ever carries the
// full account number. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { encryptField, decryptField } = await import('../utils/fieldEncryption.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens } = await import('../services/auth.service.js');

const ACCOUNT = '123456789012';
const VALID = {
  accountHolderName: 'Spice Route Foods',
  accountNumber: ACCOUNT,
  confirmAccountNumber: ACCOUNT,
  ifsc: 'hdfc0001234',
  bankName: 'HDFC Bank',
  branch: 'MG Road',
  accountType: 'current',
};

let mongo;
let srv;
let owner;
let otherOwner;
let admin;
let restaurant;

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
  owner = await User.create({ name: 'Owner A', email: 'a@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'Owner B', email: 'b@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'pending',
  });
});

const as = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const ownerPut = (body, user = owner) =>
  srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, { headers: as(user, 'restaurant_owner'), body });
const adminUrl = (suffix = '') => `/api/admin/stores/${restaurant._id}/payout-account${suffix}`;
const stored = () => Restaurant.findById(restaurant._id).select('+payoutAccount.accountNumberEncrypted').lean();
// Verify / reject carry the submittedAt the admin saw (the account changed since → 409).
const seen = async () => ({ submittedAt: (await srv.get(adminUrl(), as(admin, 'admin'))).body.data.account.submittedAt });
const adminVerify = async () => srv.request('PATCH', adminUrl('/verify'), { headers: as(admin, 'admin'), body: await seen() });

// ── Encryption ────────────────────────────────────────────────────────────────

test('encryption round-trips, uses a fresh IV each time, and refuses tampered values', () => {
  const a = encryptField(ACCOUNT);
  const b = encryptField(ACCOUNT);
  assert.notEqual(a, b, 'same plaintext never encrypts to the same string');
  assert.ok(a.startsWith('v1:'));
  assert.ok(!a.includes(ACCOUNT));
  assert.equal(decryptField(a), ACCOUNT);

  const [v, iv, tag, ct] = a.split(':');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 0xff;
  assert.throws(() => decryptField([v, iv, tag, flipped.toString('base64')].join(':')), (e) => e.code === 'DECRYPTION_FAILED');
  assert.throws(() => decryptField('not-encrypted'), (e) => e.code === 'DECRYPTION_FAILED');
});

test('production refuses to boot without DATA_ENCRYPTION_KEY', () => {
  const emptyEnv = fileURLToPath(new URL('../test-utils/empty.env', import.meta.url));
  const run = spawnSync(process.execPath, ['-e', "import('./config/env.js')"], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: emptyEnv,
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:1/x',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      JWT_STAFF_SECRET: 'c'.repeat(40),
      JWT_PARTNER_SECRET: 'd'.repeat(40),
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /DATA_ENCRYPTION_KEY is not set/);
  assert.doesNotMatch(run.stderr + run.stdout, /[A-Za-z0-9+/]{43}=/, 'no key material printed');
});

// ── Owner ─────────────────────────────────────────────────────────────────────

test('owner adds an account: stored encrypted, shown as last 4, pending verification', async () => {
  const res = await ownerPut(VALID);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { account } = res.body.data;
  assert.equal(account.status, 'pending_verification');
  assert.equal(account.accountNumberLast4, '9012');
  assert.equal(account.accountNumberMasked, 'XXXXXX9012');
  assert.equal(account.ifsc, 'HDFC0001234', 'normalised to upper case');
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(ACCOUNT));

  const doc = await stored();
  assert.ok(doc.payoutAccount.accountNumberEncrypted.startsWith('v1:'));
  assert.ok(!doc.payoutAccount.accountNumberEncrypted.includes(ACCOUNT));
  assert.equal(decryptField(doc.payoutAccount.accountNumberEncrypted), ACCOUNT);
});

test('owner validation: confirmation must match, IFSC and account-number formats', async () => {
  const cases = [
    { ...VALID, confirmAccountNumber: '123456789013' },
    { ...VALID, ifsc: 'HDFC1001234' }, // 5th character must be 0
    { ...VALID, ifsc: 'HDF0001234' },
    { ...VALID, accountNumber: '12345678', confirmAccountNumber: '12345678' }, // 8 digits
    { ...VALID, accountNumber: '1234567890123456789', confirmAccountNumber: '1234567890123456789' }, // 19
    { ...VALID, accountNumber: '12345678901a', confirmAccountNumber: '12345678901a' },
    { ...VALID, accountType: 'nre' },
    { ...VALID, status: 'verified' }, // can't self-verify
  ];
  for (const body of cases) {
    const res = await ownerPut(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await stored()).payoutAccount.status, 'not_added');
});

test("owner isolation: another owner can neither read nor change this restaurant's account", async () => {
  await ownerPut(VALID);
  const read = await srv.get(`/api/owner/${restaurant._id}/payout-account`, as(otherOwner, 'restaurant_owner'));
  assert.equal(read.status, 403);
  const write = await ownerPut({ ...VALID, accountNumber: '999999999', confirmAccountNumber: '999999999' }, otherOwner);
  assert.equal(write.status, 403);
  assert.equal((await stored()).payoutAccount.accountNumberLast4, '9012');
});

// ── Re-verification on change ─────────────────────────────────────────────────

test('re-saving identical details keeps it verified; before verification a change replaces it, after verification it becomes a change request', async () => {
  // Not yet verified: a change replaces the details (still pending verification).
  await ownerPut(VALID);
  const early = await ownerPut({ ...VALID, branch: 'Indiranagar' });
  assert.equal(early.body.data.account.status, 'pending_verification');
  assert.equal(early.body.data.changeRequested, false);
  assert.equal(early.body.data.account.branch, 'Indiranagar');

  assert.equal((await adminVerify()).status, 200);
  await Restaurant.updateOne(
    { _id: restaurant._id },
    { $set: { 'payoutAccount.providerContactId': 'cont_1', 'payoutAccount.providerFundAccountId': 'fa_1' } }
  );

  const same = await ownerPut({ ...VALID, branch: 'Indiranagar' });
  assert.equal(same.body.data.changed, false);
  assert.equal(same.body.data.account.status, 'verified');

  // Verified (B12): a change is a request — the verified account stays in force.
  const changed = await ownerPut({ ...VALID, ifsc: 'ICIC0001234', accountNumber: '5555666677', confirmAccountNumber: '5555666677' });
  assert.equal(changed.body.data.changed, true);
  assert.equal(changed.body.data.changeRequested, true);
  assert.equal(changed.body.data.account.status, 'verified');
  assert.equal(changed.body.data.account.accountNumberLast4, '9012', 'payouts keep going to the verified account');
  assert.equal(changed.body.data.account.pendingChange.status, 'in_review');
  assert.equal(changed.body.data.account.pendingChange.accountNumberLast4, '6677');
  assert.equal(changed.body.data.account.hasPendingChange, true);
  const doc = await stored();
  assert.ok(doc.payoutAccount.verifiedAt, 'still verified');
  assert.equal(doc.payoutAccount.providerFundAccountId, 'fa_1', 'the live beneficiary is untouched until the change is verified');
  assert.equal(decryptField(doc.payoutAccount.accountNumberEncrypted), ACCOUNT);
});

// ── Admin ─────────────────────────────────────────────────────────────────────

test('admin view is masked; reveal returns the full number once and is audit-logged', async () => {
  await ownerPut(VALID);

  const view = await srv.get(adminUrl(), as(admin, 'admin'));
  assert.equal(view.status, 200);
  assert.equal(view.body.data.account.accountNumberMasked, 'XXXXXX9012');
  assert.doesNotMatch(JSON.stringify(view.body), new RegExp(ACCOUNT));

  const reveal = await srv.request('POST', adminUrl('/reveal'), { headers: as(admin, 'admin') });
  assert.equal(reveal.status, 200);
  assert.equal(reveal.body.data.accountNumber, ACCOUNT);
  assert.equal(reveal.headers.get('cache-control'), 'no-store');

  const log = await AdminActivityLog.findOne({ action: 'payout_account.reveal' }).lean();
  assert.ok(log, 'reveal logged');
  assert.equal(String(log.adminId), String(admin._id));
  assert.equal(String(log.targetId), String(restaurant._id));
  assert.doesNotMatch(JSON.stringify(log), new RegExp(ACCOUNT), 'the log itself never holds the number');

  const asOwner = await srv.request('POST', adminUrl('/reveal'), { headers: as(owner, 'restaurant_owner') });
  assert.equal(asOwner.status, 403);
});

test('verify / reject rules', async () => {
  const none = await srv.request('PATCH', adminUrl('/verify'), { headers: as(admin, 'admin') });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, 'NO_PAYOUT_ACCOUNT');

  await ownerPut(VALID);
  const noReason = await srv.request('PATCH', adminUrl('/reject'), { headers: as(admin, 'admin'), body: {} });
  assert.equal(noReason.status, 400);

  const rejected = await srv.request('PATCH', adminUrl('/reject'), {
    headers: as(admin, 'admin'),
    body: { reason: 'Name does not match the cheque', ...(await seen()) },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.account.status, 'rejected');
  const ownerView = await srv.get(`/api/owner/${restaurant._id}/payout-account`, as(owner, 'restaurant_owner'));
  assert.equal(ownerView.body.data.account.rejectionReason, 'Name does not match the cheque');

  const verifyRejected = await srv.request('PATCH', adminUrl('/verify'), { headers: as(admin, 'admin') });
  assert.equal(verifyRejected.status, 409, 'must be resubmitted first');

  await ownerPut({ ...VALID, accountHolderName: 'Spice Route Foods Pvt Ltd' });
  const verified = await adminVerify();
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.account.status, 'verified');
  assert.equal(verified.body.data.account.rejectionReason, null);
  const again = await srv.request('PATCH', adminUrl('/verify'), { headers: as(admin, 'admin') });
  assert.equal(again.status, 409);

  const actions = (await AdminActivityLog.find({}).lean()).map((l) => l.action).sort();
  assert.deepEqual(actions, ['payout_account.reject', 'payout_account.verify']);
});

test('no other response carries the full account number', async () => {
  await ownerPut(VALID);
  const pattern = new RegExp(ACCOUNT);
  const responses = [
    await srv.get(`/api/owner/${restaurant._id}/settings`, as(owner, 'restaurant_owner')),
    await srv.get(`/api/owner/${restaurant._id}/restaurant`, as(owner, 'restaurant_owner')),
    await srv.get('/api/owner/restaurants', as(owner, 'restaurant_owner')),
    await srv.get(`/api/admin/stores/${restaurant._id}`, as(admin, 'admin')),
    await srv.get('/api/admin/stores', as(admin, 'admin')),
  ];
  for (const res of responses) {
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const body = JSON.stringify(res.body);
    assert.doesNotMatch(body, pattern);
    assert.doesNotMatch(body, /accountNumberEncrypted/);
  }
});
