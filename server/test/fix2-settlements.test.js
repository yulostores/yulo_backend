// Regression tests for the second settlement / payout review: re-applying a settings change onto
// later scheduled versions, undoing a generation another run took over (or whose carry-in row
// next week already claimed), the settlementId index, phone numbers in the bank file and CSVs,
// weeks in zones whose DST starts at midnight, carry reversal when carrying is switched off,
// generate audit log, adjustment caps, no-store headers, the owner ledger allow-list, tips on
// the statement, IST dates in exports and bank narration, failed payouts' UTR, a late "paid" from
// an old batch, the rider payout summary, finance analytics, the old payouts index, and seeding
// finance settings on a fresh database. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const financeSettings = await import('../services/financeSettings.service.js');
const { __resetFinanceSettingsCache, createVersion, getActiveSettings } = financeSettings;
const { encryptField } = await import('../utils/fieldEncryption.js');
const { csvCell } = await import('../utils/csv.js');
const { weekBounds, dayBounds } = await import('../utils/week.js');
const settlementService = await import('../services/settlement.service.js');
const payoutBatchService = await import('../services/payoutBatch.service.js');
const payoutService = await import('../services/payout.service.js');
const financeService = await import('../services/finance.service.js');
const { SETTLEMENT_EXPORT_COLUMNS, ENTRY_EXPORT_COLUMNS, toCsv } = await import('../config/settlementExport.config.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: FinanceSettings } = await import('../models/FinanceSettings.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Payout } = await import('../models/Payout.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { generateTokens } = await import('../services/auth.service.js');

// Week of Mon 5 Oct 2026 00:00 IST (= 4 Oct 18:30 UTC) … Sun 11 Oct 23:59:59.999 IST.
const WEEK = new Date('2026-10-07T06:00:00Z');
const WEEK_START = new Date('2026-10-04T18:30:00.000Z');
const NEXT_WEEK = new Date('2026-10-14T06:00:00Z');
const NEXT_WEEK_START = new Date('2026-10-11T18:30:00.000Z');
const AFTER_BOTH = new Date('2026-10-20T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let mongo;
let srv;
let owner;
let admin;
let restaurant;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), RestaurantSettlement.init(), Payout.init(), FinanceSettings.init()]);
  srv = await startTestServer();
});
after(async () => {
  settlementService.__setSettlementClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  settlementService.__setSettlementClockForTests(() => AFTER_BOTH);
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    phone: '+91-98765 43210',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    payoutAccount: {
      accountHolderName: 'Spice Route Foods',
      accountNumberEncrypted: encryptField('111122223333'),
      accountNumberLast4: '3333',
      ifsc: 'HDFC0001234',
      accountType: 'current',
      status: 'verified',
      submittedAt: new Date('2026-09-01T00:00:00Z'),
      verifiedAt: new Date('2026-09-02T00:00:00Z'),
    },
  });
});

const as = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const row = (direction, amountPaise, fields = {}) =>
  RestaurantLedgerEntry.create({
    restaurantId: restaurant._id,
    type: 'adjustment',
    direction,
    amountPaise,
    breakdown: { kind: 'correction', gst: 0 },
    eligibleAt: new Date('2026-10-07T10:00:00Z'),
    note: 'test',
    ...fields,
  });
const generate = (at = WEEK) => settlementService.generateWeeklySettlements(at);
const settlementOf = (periodStart = WEEK_START) => RestaurantSettlement.findOne({ restaurantId: restaurant._id, periodStart }).lean();
const carryRows = () => RestaurantLedgerEntry.find({ type: 'carry_forward' }).lean();

// A settlement's stored totals must be exactly its rows.
const assertMatchesRows = async (s, label) => {
  const rows = await RestaurantLedgerEntry.find({ settlementId: s._id }).lean();
  const net = rows.reduce((n, e) => n + (e.direction === 'credit' ? e.amountPaise : -e.amountPaise), 0);
  assert.equal(s.entryCount, rows.length, `${label}: entryCount = its rows`);
  assert.equal(s.totals.netPayable, net, `${label}: netPayable = its rows`);
};

// Replaces a model static for exactly one call.
const onceAround = (model, name, wrap) => {
  const orig = model[name];
  model[name] = function (...args) {
    model[name] = orig;
    return wrap(orig.bind(this), ...args);
  };
};

const approvedSettlement = async (netPayable = 30250, periodStart = WEEK_START) =>
  RestaurantSettlement.create({
    restaurantId: restaurant._id,
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 7 * DAY - 1),
    status: 'approved',
    totals: { netPayable },
    entryCount: 1,
  });

// ── Finance Settings: re-applying onto later scheduled versions ───────────────

test('a change to a field a later version schedules itself does not wipe that scheduled change', async () => {
  const nextWeek = new Date(Date.now() + 7 * DAY);
  await createVersion({ patch: { customerPlatformFee: 1500 }, effectiveFrom: nextWeek.toISOString() }, admin._id);

  const { reappliedTo } = await createVersion({ patch: { customerPlatformFee: 1000, riderBasePay: 2500 } }, admin._id);
  assert.equal(reappliedTo.length, 1);
  assert.deepEqual(reappliedTo[0].fields, ['riderBasePay']);
  assert.deepEqual(reappliedTo[0].skippedFields, ['customerPlatformFee']);

  __resetFinanceSettingsCache();
  const now = await getActiveSettings();
  assert.equal(now.customerPlatformFee, 1000);
  const later = await getActiveSettings(new Date(nextWeek.getTime() + 60_000));
  assert.equal(later.customerPlatformFee, 1500, 'the scheduled ₹15 still takes effect');
  assert.equal(later.riderBasePay, 2500, 'the untouched field still carries the new value');
});

test('a field changed only by the first of two scheduled versions stops there', async () => {
  const d1 = new Date(Date.now() + 7 * DAY);
  const d2 = new Date(Date.now() + 14 * DAY);
  await createVersion({ patch: { customerPlatformFee: 1500 }, effectiveFrom: d1.toISOString() }, admin._id);
  await createVersion({ patch: { riderBasePay: 3000 }, effectiveFrom: d2.toISOString() }, admin._id);

  const { reappliedTo } = await createVersion({ patch: { customerPlatformFee: 1000 } }, admin._id);
  assert.equal(reappliedTo.length, 1, 'nothing left to carry into the second date');
  assert.equal(reappliedTo[0].version, null, 'no new version for a date that changes the field itself');
  assert.equal((await getActiveSettings(new Date(d2.getTime() + 60_000))).customerPlatformFee, 1500);
  assert.equal((await getActiveSettings(new Date(d2.getTime() + 60_000))).riderBasePay, 3000);
});

test('concurrent first reads of a fresh database seed exactly one version 1', async () => {
  await FinanceSettings.collection.drop().catch(() => {});
  FinanceSettings.$init = null; // as on a process that never built this model's indexes
  __resetFinanceSettingsCache();
  await Promise.all([0, 1, 2, 3].map(() => getActiveSettings(new Date())));
  assert.equal(await FinanceSettings.countDocuments({ version: 1 }), 1);
  const indexes = await FinanceSettings.collection.indexes();
  assert.ok(indexes.some((i) => i.key.version === 1 && i.unique), 'the unique version index exists');
});

// ── Generation: undo, carry rules, index ─────────────────────────────────────

test('a generation another run took over is not undone; its totals stay equal to its rows', async () => {
  await row('credit', 10000);
  await generate();
  const first = await settlementOf();

  await row('debit', 40000);
  // Run A stalls between claiming rows and writing totals; its lock expires and run B takes the
  // settlement over and saves. A's write is then refused — and it must not unclaim B's rows.
  onceAround(Restaurant, 'findById', (orig, ...args) => ({
    select: (p) => ({
      lean: async () => {
        await RestaurantSettlement.updateOne({ _id: first._id }, { $set: { 'generationLock.until': new Date(Date.now() - 1000) } });
        await generate();
        return orig(...args).select(p).lean();
      },
    }),
  }));
  await generate();

  const s = await settlementOf();
  await assertMatchesRows(s, 'this week');
  const carries = await carryRows();
  assert.equal(carries.length, 2, "B's carry pair is kept");
  assert.equal(s.totals.carryForwardOut, 30000);
});

test('a failed generation whose carry-in row next week already claimed keeps the pair; no empty draft is left', async () => {
  await row('debit', 5000);
  // After the pair is written, next week is generated (claiming the carry-in row), then this run fails.
  onceAround(Restaurant, 'findById', () => ({
    select: () => ({
      lean: async () => {
        await generate(NEXT_WEEK);
        throw new Error('boom');
      },
    }),
  }));
  await generate();

  assert.equal(await settlementOf(), null, 'no empty draft settlement left behind');
  const next = await settlementOf(NEXT_WEEK_START);
  await assertMatchesRows(next, 'next week');
  assert.equal(next.totals.carryForwardIn, -5000);
  // This week's pair, plus next week's own carry of the −₹50 it now holds.
  const kept = await carryRows();
  assert.equal(kept.filter((e) => e.breakdown.role === 'in' && String(e.settlementId) === String(next._id)).length, 1, 'the claimed carry-in row is kept');
  assert.equal(kept.length, 4, 'the pair is not half-deleted');

  // Generating this week again settles it with what it has — and doesn't carry twice.
  await generate();
  const again = await settlementOf();
  await assertMatchesRows(again, 'this week, again');
  assert.equal(again.totals.netPayable, 0);
  assert.equal((await carryRows()).length, 4, 'not carried twice');
  const all = await RestaurantLedgerEntry.find().lean();
  assert.equal(all.reduce((n, e) => n + (e.direction === 'credit' ? e.amountPaise : -e.amountPaise), 0), -5000, 'money adds up');
});

test('switching carry-forward off never reverses a carry by itself; only real credits do', async () => {
  await row('debit', 5000);
  await generate();
  assert.equal((await settlementOf()).totals.carryForwardOut, 5000);

  await createVersion({ patch: { carryForwardNegative: false } }, admin._id);
  __resetFinanceSettingsCache();
  await generate();
  let s = await settlementOf();
  assert.equal(s.totals.carryForwardOut, 5000, 'still carried');
  assert.equal((await carryRows()).length, 2, 'no reversal pair');

  await row('credit', 2000);
  await generate();
  s = await settlementOf();
  assert.equal(s.totals.carryForwardOut, 3000, 'reversed only by the 2000 the week improved');
  assert.equal(s.totals.netPayable, 0);
});

test('a settlement\'s rows are found through an index', async () => {
  await row('credit', 1000);
  await generate();
  const s = await settlementOf();
  const plan = await RestaurantLedgerEntry.find({ settlementId: s._id }).explain('queryPlanner');
  assert.doesNotMatch(JSON.stringify(plan.queryPlanner.winningPlan), /COLLSCAN/);
});

// ── Admin API ─────────────────────────────────────────────────────────────────

test('generate is audit-logged; adjustments are capped; finance responses are no-store', async () => {
  await row('credit', 1000);
  const gen = await srv.request('POST', '/api/admin/finance/settlements/generate', { headers: as(admin, 'admin'), body: { weekStart: WEEK.toISOString() } });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const log = await AdminActivityLog.findOne({ action: 'settlement.generate' }).lean();
  assert.ok(log, 'an activity-log row');
  assert.equal(log.metadata.count, 1);
  assert.equal(gen.headers.get('cache-control'), 'no-store');

  const huge = await srv.request('POST', '/api/admin/finance/settlements/adjustments', {
    headers: as(admin, 'admin'),
    body: { restaurantId: String(restaurant._id), amountPaise: settlementService.MAX_ADJUSTMENT_PAISE + 1, direction: 'credit', note: 'typo' },
  });
  assert.equal(huge.status, 400);
  await assert.rejects(
    settlementService.addAdjustment({ restaurantId: restaurant._id, amountPaise: 9007199254740991, direction: 'credit', note: 'x', adminId: admin._id }),
    (e) => e.code === 'VALIDATION_ERROR'
  );

  const list = await srv.get('/api/admin/finance/settlements', as(admin, 'admin'));
  assert.equal(list.headers.get('cache-control'), 'no-store');
});

test('owner ledger and settlements: no-store, and no admin id on an adjustment row', async () => {
  await settlementService.addAdjustment({ restaurantId: restaurant._id, amountPaise: 500, direction: 'credit', note: 'goodwill', adminId: admin._id });
  const res = await srv.get(`/api/owner/${restaurant._id}/ledger`, as(owner, 'restaurant_owner'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const [entry] = res.body.data.entries;
  assert.equal(entry.amountPaise, 500);
  assert.equal(entry.createdBy, undefined);
  assert.equal(entry.restaurantId, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(String(admin._id)));

  const settlements = await srv.get(`/api/owner/${restaurant._id}/settlements`, as(owner, 'restaurant_owner'));
  assert.equal(settlements.headers.get('cache-control'), 'no-store');
});

// ── Statements ────────────────────────────────────────────────────────────────

test('a tip is shown on the statement, so its lines add up to the amount', async () => {
  await row('credit', 30010, {
    type: 'order_earning',
    breakdown: {
      paymentChannel: 'online',
      customerPaid: 44600,
      tip: 2000,
      yuloMoney: { platformFee: 1200, deliveryCharge: 9899 },
      settlementCharge: { base: 1264, gst: 227, total: 1491 },
      restaurantNet: 30010,
    },
  });
  await generate();
  const s = await settlementOf();
  assert.equal(s.totals.tips, 2000);
  const t = s.totals;
  assert.equal(t.grossCustomerPaid - t.tips - t.yuloMoneyPlatformFee - t.yuloMoneyDelivery - t.settlementCharge.total, t.netPayable);

  const { entries } = await settlementService.getSettlementDetail(s._id);
  const csv = toCsv(ENTRY_EXPORT_COLUMNS, entries, { audience: 'owner' });
  assert.match(csv.split('\n')[0], /Tip \(to rider\)/);
  assert.match(csv.split('\n')[1], /446\.00,20\.00,12\.00,98\.99/);
  assert.match(toCsv(SETTLEMENT_EXPORT_COLUMNS, [s]).split('\n')[0], /Tips \(to riders\)/);
});

test('exports and the bank narration print the IST week (Monday to Sunday), not UTC dates', async () => {
  // Delivered Monday 01:00 IST = Sunday 19:30 UTC.
  await row('credit', 30250, { eligibleAt: new Date('2026-10-04T19:30:00Z') });
  await generate();
  const s = await settlementOf();
  const header = toCsv(SETTLEMENT_EXPORT_COLUMNS, [s]).split('\n');
  assert.match(header[1], /,2026-10-05,2026-10-11,/);
  const { entries } = await settlementService.getSettlementDetail(s._id);
  assert.match(toCsv(ENTRY_EXPORT_COLUMNS, entries).split('\n')[1], /^2026-10-05,/);

  await settlementService.approveSettlement(s._id, admin._id);
  const { batch } = await payoutBatchService.createBatch({ adminId: admin._id });
  const file = await payoutBatchService.buildBatchFile(batch._id, admin._id);
  assert.match(file.content, /Yulo settlement 2026-10-05 to 2026-10-11/);
  // The free-text phone goes in as digits (with its +) — not a quote-prefixed cell.
  assert.match(file.content, /,\+919876543210,/);
});

test('phone numbers and negative amounts are not quote-prefixed; formulas still are', () => {
  for (const v of ['+91-98765-43210', '+1 (555) 010-0000', '-12.42', '-1,234.50', '(080) 1234']) {
    assert.doesNotMatch(csvCell(v), /'/, v);
  }
  for (const v of ['=HYPERLINK("x")', '+A1', '-2+3', '@SUM(A1)', '=1']) {
    assert.match(csvCell(v), /^"?'/, v);
  }
});

// ── Payout batches ────────────────────────────────────────────────────────────

test('a returned payout drops its UTR and paid date into the history', async () => {
  await approvedSettlement();
  const { batch } = await payoutBatchService.createBatch({ adminId: admin._id });
  const { reference } = (await settlementOf()).payout;
  await payoutBatchService.reconcileBatch(batch._id, { rows: [{ reference, status: 'paid', utr: 'UTR-E' }] }, admin._id);
  await payoutBatchService.reconcileBatch(batch._id, { rows: [{ reference, status: 'returned', reason: 'Account closed' }] }, admin._id);

  const s = await settlementOf();
  assert.equal(s.status, 'failed');
  assert.equal(s.payout.utr, null);
  assert.equal(s.payout.paidAt, null);
  assert.equal(s.payout.history.length, 1);
  assert.equal(s.payout.history[0].utr, 'UTR-E');
  assert.equal(s.payout.history[0].outcome, 'returned');

  const res = await srv.get(`/api/owner/${restaurant._id}/settlements`, as(owner, 'restaurant_owner'));
  assert.equal(res.body.data.settlements[0].payout.utr, null, 'the owner does not see a UTR on a failed payout');
});

test('a late "paid" from the old batch after a retry is flagged as a possible double payment', async () => {
  await approvedSettlement();
  const { batch: b1 } = await payoutBatchService.createBatch({ adminId: admin._id });
  const ref1 = (await settlementOf()).payout.reference;
  await payoutBatchService.reconcileBatch(b1._id, { rows: [{ reference: ref1, status: 'failed', reason: 'IFSC' }] }, admin._id);
  const s = await settlementOf();
  await payoutBatchService.retrySettlement(s._id, admin._id);
  const { batch: b2 } = await payoutBatchService.createBatch({ adminId: admin._id });
  const ref2 = (await settlementOf()).payout.reference;
  await payoutBatchService.reconcileBatch(b2._id, { rows: [{ reference: ref2, status: 'paid', utr: 'UTR-B2' }] }, admin._id);

  const late = await payoutBatchService.reconcileBatch(b1._id, { rows: [{ reference: ref1, status: 'paid', utr: 'UTR-B1-LATE' }] }, admin._id);
  assert.equal(late.summary.unmatched.length, 0);
  assert.equal(late.summary.conflicts.length, 1);
  assert.match(late.summary.conflicts[0].reason, /Possible double payment/);
  assert.equal((await settlementOf()).payout.utr, 'UTR-B2', 'nothing applied');
});

// ── Rider payouts ─────────────────────────────────────────────────────────────

const delivered = (partner, deliveredAt, { basePay = 20, distancePay = 0, tip = 0 } = {}) =>
  Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'delivered',
    deliveredAt,
    deliveryAssignment: {
      partnerId: partner._id,
      status: 'delivered',
      earningsBreakdown: { basePay, distancePay, tip, distanceKm: 1.5, computedAt: new Date() },
    },
  });

test('the payout summary is last week\'s payable rows; "Clear Pending" pays them', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi' });
  const cycle = (await getActiveSettings()).settlementCycle;
  const lastWeekMid = new Date(weekBounds(new Date(), cycle).start.getTime() - 3 * DAY);
  await delivered(partner, lastWeekMid, { basePay: 20, tip: 10 });

  const res = await srv.get('/api/admin/delivery-partners/payouts/summary?period=weekly', as(admin, 'admin'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const summary = res.body.data;
  assert.equal(summary.pendingPayments, 1);
  assert.equal(summary.totalPayable, 30);
  assert.equal(summary.payouts[0].payable, true);
  assert.ok(new Date(summary.periodEnd).getTime() < Date.now(), 'an ended week');

  // What the admin portal sends on "Clear Pending Payments".
  const ids = summary.payouts.filter((p) => p.status !== 'paid').map((p) => p._id);
  const pay = await srv.request('POST', '/api/admin/delivery-partners/payouts/mark-paid', { headers: as(admin, 'admin'), body: { payoutIds: ids } });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.data.modifiedCount, 1);

  const monthly = (await srv.get('/api/admin/delivery-partners/payouts/summary?period=monthly', as(admin, 'admin'))).body.data;
  assert.equal(monthly.pendingPayments, 0, 'monthly rows are statements, never pending payments');
});

test('rider payout adjustments are bounded and their amounts audit-logged', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111112', fullName: 'Asha' });
  const row1 = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', new Date());
  const bad = await srv.request('PATCH', `/api/admin/delivery-partners/${partner._id}/payouts/${row1._id}`, { headers: as(admin, 'admin'), body: { incentives: 1e12 } });
  assert.equal(bad.status, 400);
  const frac = await srv.request('PATCH', `/api/admin/delivery-partners/${partner._id}/payouts/${row1._id}`, { headers: as(admin, 'admin'), body: { incentives: 10.123 } });
  assert.equal(frac.status, 400);
  const ok = await srv.request('PATCH', `/api/admin/delivery-partners/${partner._id}/payouts/${row1._id}`, { headers: as(admin, 'admin'), body: { incentives: 50 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const log = await AdminActivityLog.findOne({ action: 'PAYOUT_ADJUSTED' }).lean();
  assert.equal(log.metadata.incentives, 50);
});

test('a payout upsert blocked by the old { partnerId, periodStart } index returns its figures, not null', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111113', fullName: 'Old Index' });
  await Payout.collection.dropIndexes();
  await Payout.collection.createIndex({ partnerId: 1, periodStart: 1 }, { unique: true });
  try {
    // Monday 1 June 2026 (IST) starts both a week and a month.
    const at = new Date('2026-06-02T06:00:00Z');
    await delivered(partner, at);
    const weekly = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', at);
    assert.ok(weekly && !weekly.isNew);
    const monthly = await payoutService.ensurePayoutForPeriod(partner._id, 'monthly', at);
    assert.ok(monthly, 'not null');
    assert.equal(monthly.periodType, 'monthly');
    assert.equal(monthly.deliveriesCount, 1);
  } finally {
    await Payout.collection.dropIndexes();
    await Payout.syncIndexes();
  }
});

// ── Finance analytics ─────────────────────────────────────────────────────────

test('earnings vs spending: IST months, weekly rows only, tips not counted as spending', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111114', fullName: 'Kiran' });
  // The IST week and month both start Thu 1 Oct 00:00 IST = 30 Sep 18:30 UTC.
  const start = new Date('2026-09-30T18:30:00Z');
  const common = { partnerId: partner._id, periodStart: start, status: 'paid', perDeliveryRate: 20, deliveriesCount: 2, grossEarnings: 53, tips: 20, netPayable: 73 };
  await Payout.create({ ...common, periodType: 'weekly', periodEnd: new Date(start.getTime() + 7 * DAY - 1) });
  await Payout.create({ ...common, periodType: 'monthly', periodEnd: new Date('2026-10-31T18:29:59.999Z') });

  const points = await financeService.getEarningsVsSpending({ months: 12 });
  assert.equal(points.length, 1, 'one month, not September and October');
  assert.equal(new Date(points[0].date).toISOString(), start.toISOString(), 'the IST month of October');
  assert.equal(points[0].spending, 53, 'weekly row only, without the tip');
});

test('finance overview: money rounded to the paisa; tips reported apart from rider spending', async () => {
  await Bill.create({ restaurantId: restaurant._id, type: 'delivery', orderId: restaurant._id, subtotal: 716, grandTotal: 716, status: 'paid', paidAt: new Date() });
  const overview = await financeService.getFinanceOverview();
  assert.equal(overview.commissionRevenue, 25.06);
  assert.equal(overview.riderTipsPassedThrough, 0);
});

// ── Week bounds ───────────────────────────────────────────────────────────────

test('weeks and days in zones whose DST starts at midnight begin on the right day', () => {
  for (const timezone of ['America/Santiago', 'America/Asuncion', 'America/Havana', 'America/Sao_Paulo']) {
    for (let t = Date.UTC(2017, 0, 1); t < Date.UTC(2027, 0, 1); t += DAY + 5 * 3600 * 1000) {
      for (const weekStartsOn of ['monday', 'sunday']) {
        const { start, end } = weekBounds(new Date(t), { weekStartsOn, timezone });
        assert.ok(start.getTime() <= t && end.getTime() >= t, `${timezone} ${new Date(t).toISOString()}`);
        assert.equal(weekBounds(start, { weekStartsOn, timezone }).start.getTime(), start.getTime(), `${timezone} ${start.toISOString()}`);
      }
      const d = dayBounds(new Date(t), { timezone });
      assert.ok(d.start.getTime() <= t && d.end.getTime() >= t);
    }
  }
  // Santiago, Sun 6 Sep 2026: clocks jump from 24:00 to 01:00, so the day starts at the jump.
  const { start } = weekBounds(new Date('2026-09-08T12:00:00Z'), { weekStartsOn: 'sunday', timezone: 'America/Santiago' });
  assert.equal(start.toISOString(), '2026-09-06T04:00:00.000Z');
});
