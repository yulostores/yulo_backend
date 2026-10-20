// B2 — Finance Settings: seeded defaults, versioning (immutable history, scheduled versions,
// historical lookups), validation, the admin API, and the switches that now read from it.
// In-memory MongoDB; no gateway involved.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const settingsService = await import('../services/financeSettings.service.js');
const { getActiveSettings, createVersion, listVersions, __resetFinanceSettingsCache } = settingsService;
const { default: FinanceSettings } = await import('../models/FinanceSettings.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: User } = await import('../models/User.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let admin;
let adminToken;
let customerToken;

before(async () => {
  mongo = await startMemoryMongo();
  await FinanceSettings.init();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  const customer = await User.create({ name: 'C', phone: '9000000001', role: 'customer' });
  adminToken = generateTokens(admin._id, 'admin').accessToken;
  customerToken = generateTokens(customer._id, 'customer').accessToken;
});

const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });

// ── Defaults & reads ──────────────────────────────────────────────────────────

test('first read seeds version 1 with the agreed business defaults', async () => {
  assert.equal(await FinanceSettings.countDocuments(), 0);
  const s = await getActiveSettings();

  assert.equal(s.version, 1);
  assert.equal(s.foodGstPercent, 5);
  assert.equal(s.serviceGstPercent, 18);
  assert.equal(s.customerPlatformFee, 1200);
  assert.equal(s.dineInPlatformFeeUnit, 'bill');
  assert.equal(s.deliveryPerKmRate, 800);
  assert.equal(s.deliveryMinCharge, 0);
  assert.equal(s.deliveryDistanceRounding, 0.1);
  assert.equal(s.settlementChargePercent, 3.5);
  assert.equal(s.settlementChargeBase, 'customer_total');
  assert.equal(s.codEnabled, false);
  assert.equal(s.riderBasePay, 2000);
  assert.equal(s.riderBaseKm, 2);
  assert.equal(s.riderPerKmRate, 500);
  assert.deepEqual({ ...s.settlementCycle }, { weekStartsOn: 'monday', timezone: 'Asia/Kolkata' });
  assert.equal(s.payoutDayOfWeek, 'wednesday');
  assert.equal(s.carryForwardNegative, true);
  assert.equal(s.payoutProvider, 'manual');
  assert.equal(s.refundFeeBorneBy.restaurant_reject, 'restaurant');
  assert.equal(s.customerCancelAfterPreparationRefundPercent, 0);

  // A second (concurrent-looking) read never seeds twice.
  __resetFinanceSettingsCache();
  await Promise.all([getActiveSettings(), getActiveSettings()]);
  assert.equal(await FinanceSettings.countDocuments(), 1);
});

test('the active settings object is frozen — callers cannot mutate the shared cache', async () => {
  const s = await getActiveSettings();
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.settlementCycle));
  assert.throws(() => {
    'use strict';
    s.customerPlatformFee = 1;
  }, TypeError);
});

// ── Versioning ────────────────────────────────────────────────────────────────

test('createVersion merges a partial patch onto the active version and becomes active', async () => {
  await getActiveSettings();
  const { version, changes } = await createVersion(
    { patch: { customerPlatformFee: 1500, settlementCycle: { weekStartsOn: 'sunday' } }, note: 'Fee review' },
    admin._id
  );

  assert.equal(version.version, 2);
  assert.equal(version.customerPlatformFee, 1500);
  assert.equal(version.settlementCycle.weekStartsOn, 'sunday');
  assert.equal(version.settlementCycle.timezone, 'Asia/Kolkata', 'nested fields not sent are kept');
  assert.equal(version.foodGstPercent, 5, 'untouched fields carried over');
  assert.deepEqual(
    changes.map((c) => c.field).sort(),
    ['customerPlatformFee', 'settlementCycle.weekStartsOn']
  );

  const active = await getActiveSettings();
  assert.equal(active.version, 2, 'cache busted on save');
  assert.equal(active.customerPlatformFee, 1500);
});

test('history is immutable: saving, updating or deleting an existing version is refused', async () => {
  await getActiveSettings();
  const doc = await FinanceSettings.findOne({ version: 1 });
  doc.customerPlatformFee = 1;
  await assert.rejects(doc.save(), /immutable/);
  await assert.rejects(FinanceSettings.updateOne({ version: 1 }, { $set: { customerPlatformFee: 1 } }), /immutable/);
  await assert.rejects(FinanceSettings.findOneAndUpdate({ version: 1 }, { codEnabled: true }), /immutable/);
  await assert.rejects(FinanceSettings.deleteOne({ version: 1 }), /immutable/);
  await assert.rejects(FinanceSettings.deleteMany({}), /immutable/);

  const v1 = await FinanceSettings.findOne({ version: 1 }).lean();
  assert.equal(v1.customerPlatformFee, 1200);
});

test('a future-dated version is not active until its time, then takes over without a cache reset', async () => {
  await getActiveSettings();
  const effectiveFrom = new Date(Date.now() + 400);
  await createVersion({ patch: { codEnabled: true }, effectiveFrom }, admin._id);

  const now = await getActiveSettings();
  assert.equal(now.version, 1, 'scheduled version not active yet');
  assert.equal(now.codEnabled, false);

  const later = await getActiveSettings(new Date(effectiveFrom.getTime() + 1));
  assert.equal(later.version, 2, 'a lookup at a later time sees it');

  await new Promise((r) => setTimeout(r, 500));
  const afterwards = await getActiveSettings();
  assert.equal(afterwards.version, 2, 'cache expired exactly when the scheduled version began');
  assert.equal(afterwards.codEnabled, true);
});

test('historical lookups answer with the version that was active at that moment', async () => {
  await getActiveSettings();
  const beforeChange = new Date();
  await new Promise((r) => setTimeout(r, 5));
  await createVersion({ patch: { foodGstPercent: 12 } }, admin._id);

  assert.equal((await getActiveSettings(beforeChange)).foodGstPercent, 5);
  assert.equal((await getActiveSettings()).foodGstPercent, 12);
  assert.equal((await listVersions()).length, 2);
});

test('backdated changes are refused', async () => {
  await getActiveSettings();
  await assert.rejects(
    createVersion({ patch: { codEnabled: true }, effectiveFrom: new Date(Date.now() - 3600_000) }, admin._id),
    (err) => err.code === 'VALIDATION_ERROR' && /past/.test(err.message)
  );
});

test('two admins saving at the same moment both get distinct version numbers', async () => {
  await getActiveSettings();
  const results = await Promise.all([
    createVersion({ patch: { customerPlatformFee: 1300 } }, admin._id),
    createVersion({ patch: { riderBasePay: 2500 } }, admin._id),
  ]);
  const versions = results.map((r) => r.version.version).sort();
  assert.deepEqual(versions, [2, 3]);
});

// ── Validation ────────────────────────────────────────────────────────────────

test('validation rejects negative money, out-of-range percentages, unknown fields, no-ops', async () => {
  await getActiveSettings();
  const bad = [
    { customerPlatformFee: -100 },
    { deliveryPerKmRate: 12.5 }, // paise must be whole
    { foodGstPercent: 150 },
    { settlementChargePercent: 101 },
    { customerCancelAfterPreparationRefundPercent: -1 },
    { settlementCycle: { timezone: 'Mars/Olympus' } },
    { refundFeeBorneBy: { restaurant_reject: 'customer' } },
    { payoutProvider: 'paypal' },
    { notARealSetting: 1 },
  ];
  for (const patch of bad) {
    await assert.rejects(
      createVersion({ patch }, admin._id),
      (err) => err.code === 'VALIDATION_ERROR',
      JSON.stringify(patch)
    );
  }
  await assert.rejects(
    createVersion({ patch: { customerPlatformFee: 1200 } }, admin._id),
    (err) => err.code === 'NO_CHANGES'
  );
  assert.equal(await FinanceSettings.countDocuments(), 1, 'nothing invalid was saved');
});

// ── Admin API ─────────────────────────────────────────────────────────────────

test('admin API: 401 without a token, 403 for a non-admin', async () => {
  const anon = await srv.get('/api/admin/finance/settings');
  assert.equal(anon.status, 401);

  const asCustomer = { authorization: `Bearer ${customerToken}` };
  const get = await srv.get('/api/admin/finance/settings', asCustomer);
  assert.equal(get.status, 403);
  const post = await srv.request('POST', '/api/admin/finance/settings', {
    headers: asCustomer,
    body: { settings: { codEnabled: true } },
  });
  assert.equal(post.status, 403);
  assert.equal(await FinanceSettings.countDocuments({ codEnabled: true }), 0);
});

test('admin API: GET returns active, upcoming, history and units', async () => {
  const res = await srv.get('/api/admin/finance/settings', asAdmin());
  assert.equal(res.status, 200);
  const { active, upcoming, history, units } = res.body.data;
  assert.equal(active.version, 1);
  assert.deepEqual(upcoming, []);
  assert.equal(history.length, 1);
  assert.match(units.customerPlatformFee, /paise/);
});

test('admin API: POST saves a version, logs the change, and the COD switch follows it', async () => {
  const before = await srv.get('/api/app/config');
  assert.equal(before.body.data.config.payments.codEnabled, false);

  const res = await srv.request('POST', '/api/admin/finance/settings', {
    headers: asAdmin(),
    body: { settings: { codEnabled: true, customerPlatformFee: 1500 }, note: 'Re-enable COD' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.version.version, 2);

  const log = await AdminActivityLog.findOne({ action: 'finance_settings.create_version' }).lean();
  assert.ok(log, 'activity logged');
  assert.equal(String(log.adminId), String(admin._id));
  assert.equal(log.targetType, 'finance_settings');
  assert.deepEqual(
    log.metadata.changes.map((c) => c.field).sort(),
    ['codEnabled', 'customerPlatformFee']
  );

  const afterRes = await srv.get('/api/app/config');
  assert.equal(afterRes.body.data.config.payments.codEnabled, true);

  // COD no longer refused at checkout: the request now fails later, on the empty cart.
  const checkout = await srv.request('POST', '/api/orders/checkout', {
    headers: { authorization: `Bearer ${customerToken}` },
    body: { paymentMethod: 'cod' },
  });
  assert.notEqual(checkout.body.code, 'COD_UNAVAILABLE');
});

test('admin API: invalid body or values → 400 and nothing saved', async () => {
  const cases = [
    { settings: { settlementChargePercent: 120 } },
    { settings: { customerPlatformFee: -5 } },
    { settings: { codEnabled: true }, effectiveFrom: 'next tuesday' },
    { settings: { codEnabled: true }, unexpected: 1 },
    {},
  ];
  for (const body of cases) {
    const res = await srv.request('POST', '/api/admin/finance/settings', { headers: asAdmin(), body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(await FinanceSettings.countDocuments({ version: { $gt: 1 } }), 0, 'no version was added');
});

test('admin API: a future effectiveFrom shows up as upcoming', async () => {
  const effectiveFrom = new Date(Date.now() + 24 * 3600_000).toISOString();
  const res = await srv.request('POST', '/api/admin/finance/settings', {
    headers: asAdmin(),
    body: { settings: { riderBasePay: 2500 }, effectiveFrom },
  });
  assert.equal(res.status, 201);
  const get = await srv.get('/api/admin/finance/settings', asAdmin());
  assert.equal(get.body.data.active.riderBasePay, 2000);
  assert.equal(get.body.data.upcoming.length, 1);
  assert.equal(get.body.data.upcoming[0].riderBasePay, 2500);
});
