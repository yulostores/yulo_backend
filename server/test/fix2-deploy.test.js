// Round-2 deployment-safety fixes: the GST-registration default and backfill, the owner
// settings gate for legacy GST numbers, the legacy-refund migration, the ledger backfill's
// scope (simulated payments, --until, cancelled-after-preparation, opt-in bills), dry runs
// that write nothing, the index check, and graceful shutdown with a socket client connected.
// In-memory MongoDB; no script is ever pointed at a real database or the real .env.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { generateTokens } = await import('../services/auth.service.js');
const { backfillGstRegistered } = await import('../scripts/backfillGstRegistered.js');
const { migrateLegacyRefunds } = await import('../scripts/migrateLegacyRefunds.js');
const { backfillLedger } = await import('../scripts/backfillLedger.js');
const { migratePayoutPeriods } = await import('../scripts/migratePayoutPeriods.js');
const { seedFinanceSettings } = await import('../scripts/seedFinanceSettings.js');
const { checkIndexes } = await import('../scripts/checkIndexes.js');
const { startSettlementScheduler } = await import('../jobs/settlementScheduler.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: FinanceSettings } = await import('../models/FinanceSettings.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const VALID_GSTIN = '27AAPFU0939F1ZV';
const quiet = () => {};

let mongo;
let srv;
let owner;

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
  __resetFinanceSettingsCache();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
});

// A restaurant as the pre-B2 code stored it: no gstRegistered at all.
const legacyRestaurant = async (fields = {}) => {
  const { insertedId } = await Restaurant.collection.insertOne({
    ownerId: owner._id,
    name: 'Legacy Kitchen',
    approvalStatus: 'active',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    ...fields,
  });
  return insertedId;
};
const raw = (id) => Restaurant.collection.findOne({ _id: id });

// ── 1. gstRegistered default and backfill ───────────────────────────────────────

test('a legacy restaurant loaded and saved is not stamped "not GST-registered"; a new one is', async () => {
  const id = await legacyRestaurant({ settings: { gstNumber: VALID_GSTIN } });
  const doc = await Restaurant.findById(id);
  assert.equal(doc.gstRegistered, undefined);
  doc.isActive = false; // e.g. an admin suspending it before the backfill ran
  await doc.save();
  const after = await raw(id);
  assert.equal('gstRegistered' in after, false, 'no default written back');
  assert.equal('gstRegisteredSource' in after, false);

  const fresh = await Restaurant.create({ ownerId: owner._id, name: 'New Kitchen', location: { type: 'Point', coordinates: [77, 12] } });
  assert.equal(fresh.gstRegistered, false);
  assert.equal(fresh.gstRegisteredSource, 'created');
});

test('backfill: valid GSTIN → registered; malformed → not, and listed; owner choices and re-runs untouched', async () => {
  const valid = await legacyRestaurant({ name: 'Valid', settings: { gstNumber: VALID_GSTIN } });
  const malformed = await legacyRestaurant({ name: 'Placeholder', settings: { gstNumber: '27AACR1234F1Z1' } });
  const none = await legacyRestaurant({ name: 'No GST' });
  // A legacy "false" that was only ever the old schema default, written back by a save.
  const stampedFalse = await legacyRestaurant({ name: 'Stamped', gstRegistered: false, settings: { gstNumber: VALID_GSTIN } });
  // A real decision: the owner turned it off.
  const ownerOff = await legacyRestaurant({
    name: 'Owner said no',
    gstRegistered: false,
    gstRegisteredSource: 'owner',
    settings: { gstNumber: VALID_GSTIN },
  });

  const lines = [];
  const dry = await backfillGstRegistered({ apply: false, log: (l) => lines.push(l) });
  assert.deepEqual(dry, { setTrue: 0, setFalse: 0, malformed: 1 });
  assert.equal('gstRegistered' in (await raw(valid)), false, 'dry run writes nothing');
  assert.ok(lines.some((l) => l.includes(String(malformed)) && l.includes('Placeholder')), 'malformed number reported');

  const applied = await backfillGstRegistered({ apply: true, log: quiet });
  assert.deepEqual(applied, { setTrue: 2, setFalse: 2, malformed: 1 });
  assert.equal((await raw(valid)).gstRegistered, true);
  assert.equal((await raw(stampedFalse)).gstRegistered, true, 'a default-stamped false is corrected');
  assert.equal((await raw(malformed)).gstRegistered, false);
  assert.equal((await raw(none)).gstRegistered, false);
  assert.equal((await raw(valid)).gstRegisteredSource, 'backfill');
  assert.equal((await raw(ownerOff)).gstRegistered, false, "the owner's decision stands");
  assert.equal((await raw(ownerOff)).gstRegisteredSource, 'owner');

  assert.deepEqual(await backfillGstRegistered({ apply: true, log: quiet }), { setTrue: 0, setFalse: 0, malformed: 0 });
});

// ── 2. Owner settings: a legacy GST number doesn't block unrelated edits ────────

const completeStore = (fields = {}) => ({
  name: 'Legacy Kitchen',
  email: 'kitchen@test.local',
  phone: '9876543210',
  address: { street: '1 Main Road', city: 'Pune', state: 'MH', pincode: '411001' },
  settings: { legalEntityType: 'Partnership', ownerName: 'A Owner', panNumber: 'ABCDE1234F', gstNumber: '27AACR1234F1Z1' },
  ...fields,
});
const ownerHeaders = () => ({ authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` });
const patchSettings = (id, body) =>
  srv.request('PATCH', `/api/owner/${id}/settings`, { headers: ownerHeaders(), body });

test('a GST-registered store with a legacy-format number can still save other details; GST edits are checked', async () => {
  const id = await legacyRestaurant(completeStore({ gstRegistered: true, gstRegisteredSource: 'admin' }));

  const phoneFix = await patchSettings(id, { phone: '9123456780' });
  assert.equal(phoneFix.status, 200, JSON.stringify(phoneFix.body));
  assert.equal((await raw(id)).phone, '9123456780');

  const badNumber = await patchSettings(id, { settings: { gstNumber: '27AACR1234F1Z2' } });
  assert.equal(badNumber.status, 400);
  assert.ok(badNumber.body.details?.fieldErrors?.['settings.gstNumber']);

  const fixed = await patchSettings(id, { settings: { gstNumber: VALID_GSTIN } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
});

test("the owner's GST toggle is recorded as their decision", async () => {
  const id = await legacyRestaurant(completeStore({ settings: { ...completeStore().settings, gstNumber: VALID_GSTIN } }));
  const res = await patchSettings(id, { gstRegistered: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const doc = await raw(id);
  assert.equal(doc.gstRegistered, true);
  assert.equal(doc.gstRegisteredSource, 'owner');
  assert.ok(doc.gstRegisteredSetAt instanceof Date);
  // …so a later backfill run leaves it alone even if the owner switches it off.
  await patchSettings(id, { gstRegistered: false });
  await backfillGstRegistered({ apply: true, log: quiet });
  assert.equal((await raw(id)).gstRegistered, false);
});

// ── 3. Legacy refunds ────────────────────────────────────────────────────────

test('legacy owed refunds become tracked pending refunds; simulated ones are left alone; idempotent', async () => {
  const restaurantId = await legacyRestaurant();
  const order = (fields) =>
    Order.collection.insertOne({
      restaurantId,
      type: 'delivery',
      status: 'cancelled',
      subtotal: 300,
      grandTotal: 357,
      paymentMethod: 'online',
      paymentStatus: 'paid',
      refundStatus: 'pending',
      ...fields,
    });
  const real = (await order({ razorpayPaymentId: 'pay_REAL1' })).insertedId;
  const sim = (await order({ razorpayPaymentId: 'sim_abc123' })).insertedId;
  const tracked = (await order({ razorpayPaymentId: 'pay_REAL2', refund: { status: 'processing', amountPaise: 35700 } })).insertedId;
  const bill = (
    await Bill.collection.insertOne({
      restaurantId,
      type: 'dine_in',
      status: 'paid',
      subtotal: 600,
      grandTotal: 642,
      razorpayPaymentId: 'pay_BILL1',
      refundStatus: 'pending',
    })
  ).insertedId;

  const dry = await migrateLegacyRefunds({ apply: false, log: quiet });
  assert.equal(dry.orders.found, 2);
  assert.equal(dry.orders.simulated, 1);
  assert.equal((await Order.collection.findOne({ _id: real })).refund, undefined, 'dry run writes nothing');

  await migrateLegacyRefunds({ apply: true, log: quiet });
  const migrated = (await Order.collection.findOne({ _id: real })).refund;
  assert.equal(migrated.status, 'pending');
  assert.equal(migrated.amountPaise, 35700);
  assert.equal(migrated.feeBorneBy, 'platform');
  assert.equal((await Order.collection.findOne({ _id: sim })).refund, undefined);
  assert.equal((await Order.collection.findOne({ _id: tracked })).refund.status, 'processing');
  assert.equal((await Bill.collection.findOne({ _id: bill })).refund.amountPaise, 64200);

  const again = await migrateLegacyRefunds({ apply: true, log: quiet });
  assert.equal(again.orders.migrated + again.bills.migrated, 0);
});

// ── 4. Ledger backfill scope ─────────────────────────────────────────────────

test('ledger backfill: real payments only, inside the window; cancelled-after-preparation credited; bills opt-in', async () => {
  await getActiveSettings(); // settings seeded, as the runbook requires
  const restaurantId = await legacyRestaurant();
  const base = {
    restaurantId,
    type: 'delivery',
    items: [{ menuItemId: restaurantId, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    tax: 15,
    platformFee: 12,
    deliveryFee: 30,
    grandTotal: 357,
    paymentMethod: 'online',
    paymentStatus: 'paid',
  };
  const inWindow = new Date('2026-10-20T10:00:00Z');
  const delivered = await Order.create({ ...base, status: 'delivered', deliveredAt: inWindow, razorpayPaymentId: 'pay_D1' });
  const simulated = await Order.create({ ...base, status: 'delivered', deliveredAt: inWindow, razorpayPaymentId: 'sim_x' });
  const tooLate = await Order.create({ ...base, status: 'delivered', deliveredAt: new Date('2026-11-05T10:00:00Z'), razorpayPaymentId: 'pay_D2' });
  const cancelledAfterPrep = await Order.create({
    ...base,
    status: 'cancelled',
    cancelledBy: 'customer',
    cancelledAt: inWindow,
    razorpayPaymentId: 'pay_C1',
    statusHistory: [{ status: 'confirmed' }, { status: 'preparing' }, { status: 'cancelled', byRole: 'customer' }],
  });
  const cancelledEarly = await Order.create({
    ...base,
    status: 'cancelled',
    cancelledBy: 'customer',
    cancelledAt: inWindow,
    razorpayPaymentId: 'pay_C2',
    statusHistory: [{ status: 'confirmed' }, { status: 'cancelled', byRole: 'customer' }],
  });
  const bill = (
    await Bill.collection.insertOne({
      restaurantId,
      type: 'dine_in',
      status: 'paid',
      paidBy: 'online',
      paidAt: inWindow,
      subtotal: 600,
      grandTotal: 642,
      razorpayPaymentId: 'pay_B1',
    })
  ).insertedId;

  const window = { since: new Date('2026-10-19T00:00:00Z'), until: new Date('2026-10-31T00:00:00Z') };
  const dry = await backfillLedger({ ...window, log: quiet });
  assert.deepEqual(dry.found, { delivered: 1, cancelled: 1, bills: 0 });
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 0, 'dry run writes nothing');

  await backfillLedger({ ...window, apply: true, log: quiet });
  const credited = new Set((await RestaurantLedgerEntry.find().lean()).map((e) => String(e.orderId ?? e.billId)));
  assert.ok(credited.has(String(delivered._id)));
  assert.ok(credited.has(String(cancelledAfterPrep._id)));
  assert.ok(!credited.has(String(simulated._id)), 'simulated payment never credited');
  assert.ok(!credited.has(String(tooLate._id)), 'outside --until');
  assert.ok(!credited.has(String(cancelledEarly._id)), 'cancelled before preparation: refunded, not credited');
  assert.ok(!credited.has(String(bill)), 'bills only with --include-bills');

  await backfillLedger({ ...window, includeBills: true, apply: true, log: quiet });
  const billRow = await RestaurantLedgerEntry.findOne({ billId: bill }).lean();
  assert.equal(billRow.type, 'dine_in_earning');
  assert.equal(billRow.direction, 'credit');
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 3);

  await backfillLedger({ ...window, includeBills: true, apply: true, log: quiet });
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 3, 're-runnable');
});

test('ledger backfill refuses to run before Finance Settings are seeded (it never seeds them)', async () => {
  await assert.rejects(
    backfillLedger({ since: new Date('2026-10-01'), log: quiet }),
    /seedFinanceSettings/
  );
  assert.equal(await FinanceSettings.countDocuments(), 0);
});

// ── 5. Dry runs write nothing; seeding is deliberate ─────────────────────────

test('payout-period migration dry run does not seed Finance Settings; --apply needs them', async () => {
  await migratePayoutPeriods({ apply: false, log: quiet });
  assert.equal(await FinanceSettings.countDocuments(), 0);
  await assert.rejects(migratePayoutPeriods({ apply: true, log: quiet }), /seedFinanceSettings/);
});

test('seedFinanceSettings: dry run shows the values and writes nothing; --apply seeds version 1 once', async () => {
  const lines = [];
  const dry = await seedFinanceSettings({ apply: false, log: (l) => lines.push(l) });
  assert.equal(dry.seeded, false);
  assert.ok(dry.preview.some((p) => p.field === 'customerPlatformFee' && p.value === '12'));
  assert.equal(await FinanceSettings.countDocuments(), 0);

  const seeded = await seedFinanceSettings({ apply: true, log: quiet });
  assert.equal(seeded.seeded, true);
  assert.equal(seeded.active.customerPlatformFee, 1200);
  assert.equal((await seedFinanceSettings({ apply: true, log: quiet })).seeded, false);
  assert.equal(await FinanceSettings.countDocuments(), 1);
});

// ── 6. Index check ───────────────────────────────────────────────────────────

test('checkIndexes fails on a missing unique index and passes once it is built', async () => {
  await RestaurantLedgerEntry.init();
  const ok = await checkIndexes({ models: [RestaurantLedgerEntry], log: quiet });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const unique = (await RestaurantLedgerEntry.collection.indexes()).find((ix) => ix.unique);
  await RestaurantLedgerEntry.collection.dropIndex(unique.name);
  const broken = await checkIndexes({ models: [RestaurantLedgerEntry], log: quiet });
  assert.equal(broken.ok, false);
  assert.equal(broken.missingUnique[0].model, 'RestaurantLedgerEntry');

  await RestaurantLedgerEntry.syncIndexes();
});

// ── 7. Shutdown ──────────────────────────────────────────────────────────────

test('the settlement scheduler stops cleanly', async () => {
  const scheduler = startSettlementScheduler();
  await scheduler.stop(); // resolves; no timers left behind to keep the process alive
});

test('SIGTERM exits promptly even with a Socket.IO client connected', async () => {
  const { WebSocket } = await import('ws');
  const port = 4800 + Math.floor(Math.random() * 150);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: './test-utils/empty.env',
      NODE_ENV: 'development',
      PORT: String(port),
      MONGODB_URI: `${mongo.uri}shutdown_test`,
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
      JWT_STAFF_SECRET: process.env.JWT_STAFF_SECRET,
      JWT_PARTNER_SECRET: process.env.JWT_PARTNER_SECRET,
      DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
      LOG_LEVEL: 'error',
    },
  });
  // Shutdown catches its own errors and still exits 0 — so read the log too.
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    // Wait for the server to answer.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, 'server came up');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const t0 = Date.now();
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    assert.equal(code, 0, `exited with ${code}`);
    assert.ok(Date.now() - t0 < 8000);
    assert.doesNotMatch(output, /Error during shutdown/, output);
    ws.terminate();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('an admin setting the GST flag records it as a decision the backfill never overrides', async () => {
  const id = await legacyRestaurant({ settings: { gstNumber: VALID_GSTIN } });
  const admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const res = await srv.request('PATCH', `/api/admin/stores/${id}`, {
    headers: { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` },
    body: { gstRegistered: false },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await raw(id);
  assert.equal(stored.gstRegistered, false);
  assert.equal(stored.gstRegisteredSource, 'admin');
  assert.ok(stored.gstRegisteredSetAt instanceof Date);

  await backfillGstRegistered({ apply: true, log: quiet });
  assert.equal((await raw(id)).gstRegistered, false, 'the admin decided — a valid GSTIN on file does not flip it');
});
