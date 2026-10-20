// B8 — the weekly settlement engine: IST week boundaries, idempotent generation, totals equal
// to the sum of the rows, negative weeks carried forward, unverified accounts held, admin
// actions, owner isolation and CSV columns, the scheduler's Redis lock, and the demo seed.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const { computeRestaurantSettlementLine } = await import('../services/settlementMath.service.js');
const settlementService = await import('../services/settlement.service.js');
const { runSettlementTick } = await import('../jobs/settlementScheduler.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: mongoose } = await import('mongoose');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let owner;
let otherOwner;
let admin;
let restaurant;
let otherRestaurant;

// Week of Mon 5 Oct 2026 00:00 IST (= 4 Oct 18:30 UTC) … Sun 11 Oct 23:59:59.999 IST.
const WEEK = new Date('2026-10-07T06:00:00Z');
const WEEK_START = '2026-10-04T18:30:00.000Z';
const SUNDAY_2359_IST = new Date('2026-10-11T18:29:00Z');
const MONDAY_0001_IST = new Date('2026-10-11T18:31:00Z');

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), RestaurantSettlement.init()]);
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  // These weeks are fixed dates; let the business clock say both have ended (approval needs it).
  settlementService.__setSettlementClockForTests(() => new Date('2026-10-20T00:00:00Z'));
  owner = await User.create({ name: 'A', email: 'a@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'B', email: 'b@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const base = { location: { type: 'Point', coordinates: [77.59, 12.97] }, approvalStatus: 'active', gstRegistered: true };
  restaurant = await Restaurant.create({ ...base, ownerId: owner._id, name: 'Spice Route', payoutAccount: { status: 'verified', accountNumberLast4: '9012' } });
  otherRestaurant = await Restaurant.create({ ...base, ownerId: otherOwner._id, name: 'Other', payoutAccount: { status: 'verified' } });
});

const as = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });

// A real settlement line for one of the PDF cases, as the ledger would have written it.
const PDF = { deliveryPerKmRate: 2542, deliveryMinCharge: 0, deliveryDistanceRounding: 0.1 };
const lineFor = async ({ orderType = 'delivery', free = false, channel = 'online', fee = 0 }) => {
  const settings = { ...(await getActiveSettings()), ...PDF };
  const charges = computeCustomerCharges({
    orderType,
    foodSubtotalPaise: 30000,
    restaurant: { gstRegistered: true, delivery: free ? { freeThreshold: 100 } : {} },
    distanceKm: orderType === 'delivery' ? 1 : null,
    settings,
  });
  return computeRestaurantSettlementLine({ charges, paymentChannel: channel, razorpayFeePaise: fee, settings });
};

const entry = async (fields) => {
  const line = fields.line;
  const net = line?.restaurantNet;
  return RestaurantLedgerEntry.create({
    restaurantId: restaurant._id,
    eligibleAt: new Date('2026-10-07T10:00:00Z'),
    ...(line ? { direction: net >= 0 ? 'credit' : 'debit', amountPaise: Math.abs(net), breakdown: line } : {}),
    orderId: new mongoose.Types.ObjectId(),
    ...fields,
    line: undefined,
  });
};

const generate = () => settlementService.generateWeeklySettlements(WEEK);
const settlementOf = (r = restaurant, periodStart = new Date(WEEK_START)) =>
  RestaurantSettlement.findOne({ restaurantId: r._id, periodStart }).lean();

// ── Weeks ─────────────────────────────────────────────────────────────────────

test('IST week boundary: Sunday 23:59 IST settles in its week, Monday 00:01 IST in the next', async () => {
  const line = await lineFor({});
  await entry({ type: 'order_earning', line, eligibleAt: SUNDAY_2359_IST });
  await entry({ type: 'order_earning', line, eligibleAt: MONDAY_0001_IST });

  const { periodStart, periodEnd } = await generate();
  assert.equal(periodStart.toISOString(), WEEK_START);
  assert.equal(periodEnd.toISOString(), '2026-10-11T18:29:59.999Z');
  const week1 = await settlementOf();
  assert.equal(week1.entryCount, 1);
  assert.equal(week1.totals.netPayable, 30250);

  await settlementService.generateWeeklySettlements(MONDAY_0001_IST);
  const week2 = await settlementOf(restaurant, new Date('2026-10-11T18:30:00Z'));
  assert.equal(week2.entryCount, 1);
});

// ── Totals ────────────────────────────────────────────────────────────────────

test('totals are the sum of the rows: every PDF case, a counter bill, a refund fee and a penalty', async () => {
  await entry({ type: 'order_earning', line: await lineFor({}) }); // +30250
  await entry({ type: 'order_earning', line: await lineFor({ free: true }) }); // +27355
  await entry({ type: 'dine_in_earning', line: await lineFor({ orderType: 'dine_in' }), orderId: undefined, billId: new mongoose.Types.ObjectId() }); // +30355
  await entry({ type: 'counter_platform_fee', line: await lineFor({ orderType: 'dine_in', channel: 'counter' }), orderId: undefined, billId: new mongoose.Types.ObjectId() }); // −1242
  await entry({ type: 'refund_gateway_fee', direction: 'debit', amountPaise: 1138, breakdown: { cause: 'restaurant_reject' } });
  await settlementService.addAdjustment({ restaurantId: restaurant._id, amountPaise: 500, direction: 'debit', kind: 'penalty', note: 'Late handover', adminId: admin._id });
  await RestaurantLedgerEntry.updateOne({ type: 'adjustment' }, { $set: { eligibleAt: new Date('2026-10-08T10:00:00Z') } });

  await generate();
  const s = await settlementOf();
  const rows = await RestaurantLedgerEntry.find({ settlementId: s._id }).lean();
  const sum = rows.reduce((n, e) => n + (e.direction === 'credit' ? e.amountPaise : -e.amountPaise), 0);

  assert.equal(s.entryCount, 6);
  assert.equal(s.totals.netPayable, sum);
  assert.equal(s.totals.netPayable, 30250 + 27355 + 30355 - 1242 - 1138 - 500);
  assert.equal(s.totals.grossCustomerPaid, 35700 + 32700 + 32700);
  assert.equal(s.totals.yuloMoneyPlatformFee, 3600);
  assert.equal(s.totals.yuloMoneyDelivery, 3000);
  assert.equal(s.totals.restaurantBorneDelivery, 3000);
  assert.equal(s.totals.settlementCharge.total, 1250 + 1145 + 1145);
  assert.equal(s.totals.settlementCharge.base + s.totals.settlementCharge.gst, s.totals.settlementCharge.total);
  assert.equal(s.totals.counterPlatformFees, 1242);
  assert.equal(s.totals.refundGatewayFees, 1138);
  assert.equal(s.totals.penalties, 500);
  assert.equal(s.status, 'draft');
});

// ── Idempotency ───────────────────────────────────────────────────────────────

test('generation is idempotent; open weeks pick up late rows; approved weeks are frozen', async () => {
  const line = await lineFor({});
  await entry({ type: 'order_earning', line });
  await generate();
  await generate();
  assert.equal(await RestaurantSettlement.countDocuments(), 1);
  assert.equal((await settlementOf()).totals.netPayable, 30250);

  await entry({ type: 'order_earning', line });
  await generate();
  assert.equal((await settlementOf()).totals.netPayable, 60500, 'late row added while still draft');

  await settlementService.approveSettlement((await settlementOf())._id, admin._id);
  await entry({ type: 'order_earning', line });
  await generate();
  const frozen = await settlementOf();
  assert.equal(frozen.status, 'approved');
  assert.equal(frozen.totals.netPayable, 60500, 'approved settlement untouched');
  assert.equal(await RestaurantLedgerEntry.countDocuments({ settlementId: null }), 1, 'the new row waits for a later week');

  // Two generators at once never put one row in two settlements.
  await Promise.all([settlementService.generateWeeklySettlements(MONDAY_0001_IST), settlementService.generateWeeklySettlements(MONDAY_0001_IST)]);
  assert.equal(await RestaurantSettlement.countDocuments({ restaurantId: restaurant._id }), 2);
  assert.equal(await RestaurantLedgerEntry.countDocuments({ settlementId: null }), 0);
});

// ── Holds & carry-forward ─────────────────────────────────────────────────────

test('negative week → on hold, net zeroed, shortfall carried into next week exactly once', async () => {
  const counter = await lineFor({ orderType: 'dine_in', channel: 'counter' });
  await entry({ type: 'counter_platform_fee', line: counter, orderId: undefined, billId: new mongoose.Types.ObjectId() });

  await generate();
  const s = await settlementOf();
  assert.equal(s.status, 'on_hold');
  assert.equal(s.holdReason, 'NEGATIVE_BALANCE_CARRIED_FORWARD');
  assert.equal(s.totals.netPayable, 0);
  assert.equal(s.totals.carryForwardOut, 1242);

  await generate(); // re-running must not carry it twice
  assert.equal(await RestaurantLedgerEntry.countDocuments({ type: 'carry_forward' }), 2);

  await entry({ type: 'order_earning', line: await lineFor({}), eligibleAt: MONDAY_0001_IST });
  await settlementService.generateWeeklySettlements(MONDAY_0001_IST);
  const next = await settlementOf(restaurant, new Date('2026-10-11T18:30:00Z'));
  assert.equal(next.totals.carryForwardIn, -1242);
  assert.equal(next.totals.netPayable, 30250 - 1242);
  assert.equal(next.status, 'draft');
});

test('bank account not verified → on hold; verified later → back to draft; approval needs it', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.status': 'pending_verification' } });
  await entry({ type: 'order_earning', line: await lineFor({}) });
  await generate();
  let s = await settlementOf();
  assert.equal(s.status, 'on_hold');
  assert.equal(s.holdReason, 'PAYOUT_ACCOUNT_NOT_VERIFIED');
  await assert.rejects(settlementService.approveSettlement(s._id, admin._id), (e) => e.code === 'NOT_APPROVABLE');

  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.status': 'verified' } });
  await generate();
  s = await settlementOf();
  assert.equal(s.status, 'draft');
  assert.equal(s.holdReason, null);
});

// ── Admin API ─────────────────────────────────────────────────────────────────

test('admin flow: generate → approve → hold → unhold → approve → mark paid with UTR; all logged', async () => {
  await entry({ type: 'order_earning', line: await lineFor({ fee: 1138 }) });
  const headers = as(admin, 'admin');
  const gen = await srv.request('POST', '/api/admin/finance/settlements/generate', { headers, body: { weekStart: WEEK.toISOString() } });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const id = gen.body.data.settlements[0]._id;

  const detail = await srv.get(`/api/admin/finance/settlements/${id}`, headers);
  assert.equal(detail.body.data.platformTotals.gatewayFees, 1138);
  assert.equal(detail.body.data.platformTotals.yuloSettlementMargin, 1250 - 1138);
  assert.ok('gateway' in detail.body.data.entries[0].breakdown, 'admin sees the full breakdown');

  const early = await srv.request('PATCH', `/api/admin/finance/settlements/${id}/mark-paid`, { headers, body: { utr: 'UTR12345' } });
  assert.equal(early.status, 409, 'must be approved first');

  assert.equal((await srv.request('PATCH', `/api/admin/finance/settlements/${id}/approve`, { headers })).status, 200);
  const held = await srv.request('PATCH', `/api/admin/finance/settlements/${id}/hold`, { headers, body: { note: 'Checking a dispute' } });
  assert.equal(held.body.data.settlement.status, 'on_hold');
  await generate();
  assert.equal((await RestaurantSettlement.findById(id).lean()).status, 'on_hold', 'regeneration keeps a manual hold');
  const released = await srv.request('PATCH', `/api/admin/finance/settlements/${id}/unhold`, { headers });
  assert.equal(released.body.data.settlement.status, 'draft');
  await srv.request('PATCH', `/api/admin/finance/settlements/${id}/approve`, { headers });
  const paid = await srv.request('PATCH', `/api/admin/finance/settlements/${id}/mark-paid`, { headers, body: { utr: 'UTR12345' } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.data.settlement.status, 'paid');
  assert.equal(paid.body.data.settlement.payout.utr, 'UTR12345');

  const actions = (await AdminActivityLog.find({ targetType: 'settlement' }).lean()).map((l) => l.action);
  assert.deepEqual(actions, [
    'settlement.generate',
    'settlement.approve',
    'settlement.hold',
    'settlement.unhold',
    'settlement.approve',
    'settlement.mark_paid',
  ]);

  const asOwner = await srv.get(`/api/admin/finance/settlements/${id}`, as(owner, 'restaurant_owner'));
  assert.equal(asOwner.status, 403);
});

test('adjustments: penalties must be debits and need a note; they land in the current week', async () => {
  const headers = as(admin, 'admin');
  const bad = await srv.request('POST', '/api/admin/finance/settlements/adjustments', {
    headers,
    body: { restaurantId: String(restaurant._id), amountPaise: 500, direction: 'credit', kind: 'penalty', note: 'Late' },
  });
  assert.equal(bad.status, 400);
  const ok = await srv.request('POST', '/api/admin/finance/settlements/adjustments', {
    headers,
    body: { restaurantId: String(restaurant._id), amountPaise: 2500, direction: 'credit', note: 'Goodwill for a delayed payout' },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.entry.type, 'adjustment');
});

// ── Owner API ─────────────────────────────────────────────────────────────────

test('owner sees its own settlements without fee/margin; never another restaurant\'s; CSV drops admin columns', async () => {
  await entry({ type: 'order_earning', line: await lineFor({ fee: 1138 }) });
  await RestaurantLedgerEntry.create({
    restaurantId: otherRestaurant._id,
    type: 'order_earning',
    direction: 'credit',
    amountPaise: 100,
    orderId: new mongoose.Types.ObjectId(),
    eligibleAt: new Date('2026-10-07T10:00:00Z'),
  });
  await generate();
  const mine = await settlementOf();
  const theirs = await settlementOf(otherRestaurant);

  const list = await srv.get(`/api/owner/${restaurant._id}/settlements`, as(owner, 'restaurant_owner'));
  assert.equal(list.body.data.total, 1);

  const detail = await srv.get(`/api/owner/${restaurant._id}/settlements/${mine._id}`, as(owner, 'restaurant_owner'));
  assert.equal(detail.status, 200);
  assert.doesNotMatch(JSON.stringify(detail.body), /gateway|yuloSettlementMargin|riderPay|platformTotals/);

  const sneaky = await srv.get(`/api/owner/${restaurant._id}/settlements/${theirs._id}`, as(owner, 'restaurant_owner'));
  assert.equal(sneaky.status, 404);
  const foreignPath = await srv.get(`/api/owner/${otherRestaurant._id}/settlements`, as(owner, 'restaurant_owner'));
  assert.equal(foreignPath.status, 403);

  const ownerCsv = await srv.get(`/api/owner/${restaurant._id}/settlements/${mine._id}/export`, as(owner, 'restaurant_owner'));
  assert.equal(ownerCsv.status, 200);
  assert.match(ownerCsv.headers.get('content-type'), /text\/csv/);
  assert.doesNotMatch(ownerCsv.body, /Razorpay fee|Yulo settlement margin|Rider pay/);
  assert.match(ownerCsv.body, /302\.50/);

  const adminCsv = await srv.get(`/api/admin/finance/settlements/${mine._id}/export`, as(admin, 'admin'));
  assert.match(adminCsv.body, /Razorpay fee/);
  assert.match(adminCsv.body, /11\.38/);
  const weekCsv = await srv.get(`/api/admin/finance/settlements/export?weekStart=${WEEK.toISOString()}`, as(admin, 'admin'));
  assert.equal(weekCsv.body.trim().split('\n').length, 3, 'header + one row per restaurant');
});

// ── Scheduler ─────────────────────────────────────────────────────────────────

// A Redis stand-in with SET … NX semantics (atomic per call in this single-threaded process).
const fakeRedis = () => {
  const store = new Map();
  return {
    status: 'ready',
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v, ...args) {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    async del(k) {
      store.delete(k);
      return 1;
    },
  };
};

test('scheduler: not due before Monday 03:00 IST; the lock lets exactly one instance generate', async () => {
  const mondayTwoAm = new Date('2026-10-11T20:30:00Z'); // Mon 12 Oct 02:00 IST
  const mondayFourAm = new Date('2026-10-11T22:30:00Z'); // Mon 12 Oct 04:00 IST
  let calls = 0;
  const generateSpy = async (weekStart) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(weekStart.toISOString(), WEEK_START, 'generates LAST week');
    return { periodStart: weekStart, settlements: [] };
  };
  const redis = fakeRedis();

  assert.equal(await runSettlementTick({ now: mondayTwoAm, redis, generate: generateSpy }), 'not_due');

  const results = await Promise.all([
    runSettlementTick({ now: mondayFourAm, redis, generate: generateSpy }),
    runSettlementTick({ now: mondayFourAm, redis, generate: generateSpy }),
    runSettlementTick({ now: mondayFourAm, redis, generate: generateSpy }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.sort(), ['generated', 'locked', 'locked']);
  assert.equal(await runSettlementTick({ now: mondayFourAm, redis, generate: generateSpy }), 'already_done');

  assert.equal(await runSettlementTick({ now: mondayFourAm, redis: null, generate: generateSpy }), 'no_redis');
  assert.equal(calls, 1);
});

// ── Demo seed ─────────────────────────────────────────────────────────────────

// Async on purpose: spawnSync would freeze this process — and with it the in-memory MongoDB
// connection pool the test shares — for as long as the script runs, which can time it out.
const runSeed = (env, args = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/seedSettlementDemo.js', ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

test('demo seed refuses production', async () => {
  const run = await runSeed({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to run/);
});

test('demo seed builds a week whose settlement equals the PDF cases + refund + cancel-after-prep', async () => {
  const run = await runSeed({ MONGODB_URI: `${mongo.uri}yulo_test`, NODE_ENV: 'development' }, ['--generate']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Settlement generated: status draft/);

  const demo = await Restaurant.findOne({ name: 'Demo Kitchen' }).lean();
  const s = await RestaurantSettlement.findOne({ restaurantId: demo._id }).lean();
  const refundFee = (await RestaurantLedgerEntry.findOne({ restaurantId: demo._id, type: 'refund_gateway_fee' }).lean()).amountPaise;
  assert.equal(s.entryCount, 6);
  assert.equal(s.totals.netPayable, 30250 + 27355 + 30355 - 1242 - refundFee + 30250);

  const again = await runSeed({ MONGODB_URI: `${mongo.uri}yulo_test`, NODE_ENV: 'development' });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await Restaurant.countDocuments({ name: 'Demo Kitchen' }), 1, 're-runnable');
});
