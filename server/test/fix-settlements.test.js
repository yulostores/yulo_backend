// Regression tests for the settlement / payout bug hunt: concurrent generation, carry-forward
// status, generation vs approve/hold races, ended-week rules, payout-file beneficiary checks,
// reconcile replays after a manual payment, payment references, CSV formula injection, DST week
// bounds, the owner's settlement view, failed payouts carried forward, bank-account verify
// tokens, legacy rider payout rows, and the demo seed's guard. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const { csvCell } = await import('../utils/csv.js');
const { weekBounds, dayBounds } = await import('../utils/week.js');
const settlementService = await import('../services/settlement.service.js');
const payoutBatchService = await import('../services/payoutBatch.service.js');
const payoutService = await import('../services/payout.service.js');
const { migratePayoutPeriods } = await import('../scripts/migratePayoutPeriods.js');
const { SETTLEMENT_EXPORT_COLUMNS, toCsv } = await import('../config/settlementExport.config.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: Order } = await import('../models/Order.js');
const { default: Payout } = await import('../models/Payout.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: mongoose } = await import('mongoose');
const { generateTokens } = await import('../services/auth.service.js');

// Week of Mon 5 Oct 2026 00:00 IST (= 4 Oct 18:30 UTC) … Sun 11 Oct 23:59:59.999 IST.
const WEEK = new Date('2026-10-07T06:00:00Z');
const WEEK_START = new Date('2026-10-04T18:30:00.000Z');
const NEXT_WEEK_START = new Date('2026-10-11T18:30:00.000Z');
const AFTER_BOTH = new Date('2026-10-20T00:00:00Z');

let mongo;
let srv;
let owner;
let admin;
let restaurant;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), RestaurantSettlement.init(), Payout.init()]);
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

// Replaces a model static for exactly one call.
const onceAround = (model, name, wrap) => {
  const orig = model[name];
  model[name] = function (...args) {
    model[name] = orig;
    return wrap(orig.bind(this), ...args);
  };
};

// ── Generation ────────────────────────────────────────────────────────────────

test('concurrent generations carry a negative week forward exactly once', async () => {
  await row('debit', 1000);
  await Promise.all(Array.from({ length: 5 }, () => generate()));

  const carries = await carryRows();
  assert.equal(carries.length, 2, 'one out/in pair, not one per generator');
  const s = await settlementOf();
  assert.equal(s.totals.netPayable, 0);
  assert.equal(s.totals.carryForwardOut, 1000);
  assert.equal(s.holdReason, 'NEGATIVE_BALANCE_CARRIED_FORWARD');
  assert.equal(s.generationLock.token, null, 'lock released');

  await generate(NEXT_WEEK_START);
  assert.equal((await settlementOf(NEXT_WEEK_START)).totals.carryForwardIn, -1000, 'next week debited once');
});

test('credits arriving after a carry-forward make the week payable again; the money still adds up', async () => {
  await row('debit', 1000);
  await generate();
  assert.equal((await settlementOf()).status, 'on_hold');

  await row('credit', 5000); // a late delivery dated in the same week
  await generate();
  const s = await settlementOf();
  assert.equal(s.status, 'draft', 'not stranded on hold');
  assert.equal(s.holdReason, null);
  assert.equal(s.totals.netPayable, 4000, '−10 + 50');
  assert.equal(s.totals.carryForwardOut, 0, 'the carry was reversed');
  assert.equal((await carryRows()).length, 4, 'carry pair + reversing pair');
  await generate();
  assert.equal((await carryRows()).length, 4, 're-running changes nothing');

  const approved = await settlementService.approveSettlement(s._id, admin._id);
  assert.equal(approved.status, 'approved');

  await row('credit', 2000, { eligibleAt: new Date(NEXT_WEEK_START.getTime() + 60_000) });
  await generate(NEXT_WEEK_START);
  const next = await settlementOf(NEXT_WEEK_START);
  assert.equal(next.totals.carryForwardIn, 0, 'next week is not debited for a shortfall that no longer exists');
  assert.equal(next.totals.netPayable, 2000);
});

test('a generation whose settlement moved on mid-way is undone: rows unclaimed, carry rows removed', async () => {
  await row('credit', 10000);
  await generate();
  const before = await settlementOf();
  assert.equal(before.totals.netPayable, 10000);

  const debit = await row('debit', 50000);
  // Someone else approves it while this generator is between claiming rows and writing totals
  // (as if its lock had expired).
  onceAround(Restaurant, 'findById', (orig, ...args) => ({
    select: (p) => ({
      lean: async () => {
        await RestaurantSettlement.updateOne({ _id: before._id }, { $set: { status: 'approved' } });
        return orig(...args).select(p).lean();
      },
    }),
  }));
  await generate();

  const s = await settlementOf();
  assert.equal(s.status, 'approved');
  assert.equal(s.totals.netPayable, 10000, 'approved totals untouched');
  assert.equal((await RestaurantLedgerEntry.findById(debit._id).lean()).settlementId, null, 'the row waits for a later week');
  assert.equal((await carryRows()).length, 0, 'its carry-forward pair was removed');
});

test('approve / hold / unhold are refused while a generator is re-totalling the settlement', async () => {
  await row('credit', 10000);
  await generate();
  const s = await settlementOf();
  await RestaurantSettlement.updateOne(
    { _id: s._id },
    { $set: { 'generationLock.token': 'other', 'generationLock.until': new Date(Date.now() + 60_000) } }
  );

  await assert.rejects(settlementService.approveSettlement(s._id, admin._id), (e) => e.code === 'SETTLEMENT_BUSY');
  await assert.rejects(settlementService.holdSettlement(s._id, admin._id, 'x'), (e) => e.code === 'SETTLEMENT_BUSY');
  assert.equal((await settlementOf()).status, 'draft');

  // A second generator skips it instead of interleaving.
  await row('credit', 5000);
  await generate();
  assert.equal((await settlementOf()).totals.netPayable, 10000);

  // An expired lock (crashed generator) doesn't block anything.
  await RestaurantSettlement.updateOne({ _id: s._id }, { $set: { 'generationLock.until': new Date(Date.now() - 1000) } });
  await generate();
  assert.equal((await settlementOf()).totals.netPayable, 15000);
  assert.equal((await settlementService.approveSettlement(s._id, admin._id)).status, 'approved');
});

test('hold racing a batch claim: the batch wins and the hold is refused', async () => {
  await row('credit', 10000);
  await generate();
  const s = await settlementOf();
  await settlementService.approveSettlement(s._id, admin._id);

  onceAround(RestaurantSettlement, 'findById', async (orig, ...args) => {
    const doc = await orig(...args);
    await RestaurantSettlement.updateOne({ _id: s._id }, { $set: { status: 'processing' } }); // createBatch claims it
    return doc;
  });
  await assert.rejects(settlementService.holdSettlement(s._id, admin._id, 'dispute'), (e) => e.code === 'NOT_HOLDABLE');
  assert.equal((await settlementOf()).status, 'processing');
});

test('a week that has not started cannot be generated; one that has not ended cannot be approved', async () => {
  const future = await srv.request('POST', '/api/admin/finance/settlements/generate', {
    headers: as(admin, 'admin'),
    body: { weekStart: '2026-11-04T00:00:00Z' },
  });
  assert.equal(future.status, 409);
  assert.equal(future.body.code, 'WEEK_NOT_STARTED');

  settlementService.__setSettlementClockForTests(() => new Date('2026-10-08T12:00:00Z')); // mid-week
  await row('credit', 10000);
  await generate();
  const s = await settlementOf();
  assert.equal(s.status, 'draft', 'an interim draft is fine');
  const early = await srv.request('PATCH', `/api/admin/finance/settlements/${s._id}/approve`, { headers: as(admin, 'admin') });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'WEEK_NOT_ENDED');
});

// ── Payout batches ────────────────────────────────────────────────────────────

const approvedSettlement = async (r = restaurant, netPayable = 30250, periodStart = WEEK_START) =>
  RestaurantSettlement.create({
    restaurantId: r._id,
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1),
    status: 'approved',
    totals: { netPayable },
    entryCount: 1,
  });

test('payment references use the whole settlement id', async () => {
  const other = await Restaurant.create({ ...restaurant.toObject(), _id: undefined, name: 'Other' });
  const [a, b] = [await approvedSettlement(), await approvedSettlement(other)];
  await payoutBatchService.createBatch({ adminId: admin._id });
  const refs = (await RestaurantSettlement.find({ _id: { $in: [a._id, b._id] } }).lean()).map((s) => s.payout.reference);
  assert.deepEqual(refs.sort(), [`YULO-${String(a._id).toUpperCase()}-1`, `YULO-${String(b._id).toUpperCase()}-1`].sort());
});

test('the bank file is refused once the batched account is replaced — even by a verified change', async () => {
  await approvedSettlement();
  const { batch } = await payoutBatchService.createBatch({ adminId: admin._id });
  const snap = (await settlementOf()).payout.beneficiary;
  assert.equal(snap.accountNumberLast4, '3333');
  assert.match(snap.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(snap), /111122223333/);

  const put = await srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, {
    headers: as(owner, 'restaurant_owner'),
    body: {
      accountHolderName: 'Someone Else',
      accountNumber: '999988887777',
      confirmAccountNumber: '999988887777',
      ifsc: 'ICIC0009999',
      accountType: 'savings',
    },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  // B12: a change to a verified account is only a request — the batched (verified) account is
  // still the one paid, so the file still builds.
  assert.equal(put.body.data.changeRequested, true);
  const before = await payoutBatchService.buildBatchFile(batch._id, admin._id);
  assert.match(before.content, /111122223333/);
  assert.doesNotMatch(before.content, /999988887777/);

  // The admin verifies the change: the live account is replaced — not the one batched.
  const { verifyChangeRequest } = await import('../services/payoutAccount.service.js');
  const { pendingChange } = (await Restaurant.findById(restaurant._id).lean()).payoutAccount;
  await verifyChangeRequest(restaurant._id, admin._id, { requestedAt: pendingChange.requestedAt });
  const file = await srv.get(`/api/admin/finance/payout-batches/${batch._id}/file`, as(admin, 'admin'));
  assert.equal(file.status, 409);
  assert.equal(file.body.code, 'BENEFICIARY_CHANGED');
  assert.doesNotMatch(JSON.stringify(file.body), /999988887777/);

  // Cancel and re-batch. B12: the payout was scheduled for the old account, so a batch now skips
  // it until the admin schedules it again (Change date re-confirms the destination) — then the
  // new verified account is used.
  await payoutBatchService.cancelBatch(batch._id, { confirmNotUploaded: true }, admin._id);
  await assert.rejects(payoutBatchService.createBatch({ adminId: admin._id }), (e) => e.code === 'NOTHING_TO_PAY');
  await settlementService.changeScheduledDate((await settlementOf())._id, { scheduledFor: AFTER_BOTH.toISOString() }, admin._id);
  const { batch: again } = await payoutBatchService.createBatch({ adminId: admin._id });
  const ok = await payoutBatchService.buildBatchFile(again._id, admin._id);
  assert.match(ok.content, /999988887777,ICIC0009999/);
});

test('replaying a "returned" result never reopens a settlement an admin paid by hand', async () => {
  const s = await approvedSettlement();
  const { batch } = await payoutBatchService.createBatch({ adminId: admin._id });
  const reference = (await settlementOf()).payout.reference;
  const results = [
    { reference, status: 'paid', utr: 'BANKUTR0001' },
    { reference, status: 'returned', reason: 'Account closed' },
  ];
  await payoutBatchService.reconcileBatch(batch._id, { rows: results }, admin._id);
  assert.equal((await settlementOf()).status, 'failed');

  await settlementService.markPaidManually(s._id, 'MANUAL999', admin._id);
  const replay = await payoutBatchService.reconcileBatch(batch._id, { rows: results }, admin._id);
  const after = await settlementOf();
  assert.equal(after.status, 'paid', 'stays paid — not failed again, so not payable twice');
  assert.equal(after.payout.utr, 'MANUAL999');
  assert.equal(after.payout.provider, 'manual');
  assert.equal(replay.summary.returned, 0);
  assert.ok(replay.summary.conflicts.some((c) => /by hand/.test(c.reason)));
});

test('a failed payout carried forward is its own (positive) total, not "carried in" debt', async () => {
  const s = await approvedSettlement(restaurant, 30250, new Date('2026-09-27T18:30:00Z')); // an earlier week
  await RestaurantSettlement.updateOne({ _id: s._id }, { $set: { status: 'failed' } });
  await payoutBatchService.carryForwardFailed(s._id, admin._id);

  // Carrying forward stamps the real date, so this week is the real current one — and the
  // settlement clock must agree. Left at the suite's frozen AFTER_BOTH, the test began failing
  // (WEEK_NOT_STARTED) as soon as the real calendar moved past that week.
  settlementService.__setSettlementClockForTests(() => new Date());
  const { settlements } = await settlementService.generateWeeklySettlements(new Date());
  const next = settlements.find((x) => String(x.restaurantId) === String(restaurant._id));
  assert.equal(next.totals.failedPayoutsCarriedIn, 30250);
  assert.equal(next.totals.carryForwardIn, 0);
  assert.equal(next.totals.netPayable, 30250);
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test('CSV cells that a spreadsheet would run as formulas are neutralised; numbers and phones are not', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+cmd|calc'), "'+cmd|calc");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('-12.42'), '-12.42');
  assert.equal(csvCell('+91 98765 43210'), '+91 98765 43210');
  assert.equal(csvCell('Beta Bites, LLP'), '"Beta Bites, LLP"');

  const csv = toCsv(SETTLEMENT_EXPORT_COLUMNS, [{ restaurantId: { name: '=cmd()', _id: 'x' }, totals: { netPayable: -1242 } }]);
  assert.match(csv, /^.*\n'=cmd\(\),/);
  assert.match(csv, /,-12\.42,/);
});

test('bank account holder names are limited to what a bank file can carry', async () => {
  const put = (accountHolderName) =>
    srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, {
      headers: as(owner, 'restaurant_owner'),
      body: { accountHolderName, accountNumber: '123456789012', confirmAccountNumber: '123456789012', ifsc: 'HDFC0001234', accountType: 'current' },
    });
  assert.equal((await put('=HYPERLINK("http://x")')).status, 400);
  assert.equal((await put('Spice "Route"')).status, 400);
  assert.equal((await put("D'Souza & Sons (Pvt) Ltd.")).status, 200);
});

// ── Weeks ─────────────────────────────────────────────────────────────────────

test('day and week bounds are right on a DST-change day east of UTC', () => {
  // NZ springs forward at 02:00 on Sun 27 Sep 2026; that midnight is still NZST (+12).
  const nz = weekBounds(new Date('2026-09-28T00:00:00Z'), { weekStartsOn: 'sunday', timezone: 'Pacific/Auckland' });
  assert.equal(nz.start.toISOString(), '2026-09-26T12:00:00.000Z');
  // Sydney springs forward on Sun 4 Oct 2026; that midnight is still AEST (+10).
  const syd = dayBounds(new Date('2026-10-04T05:00:00Z'), { timezone: 'Australia/Sydney' });
  assert.equal(syd.start.toISOString(), '2026-10-03T14:00:00.000Z');
  assert.equal(syd.end.toISOString(), '2026-10-04T12:59:59.999Z', 'a 23-hour day');
  assert.equal(weekBounds(WEEK).start.toISOString(), WEEK_START.toISOString(), 'IST unchanged');
});

// ── Owner view ────────────────────────────────────────────────────────────────

test('the owner sees the documented settlement fields only', async () => {
  const s = await RestaurantSettlement.create({
    restaurantId: restaurant._id,
    periodStart: WEEK_START,
    periodEnd: new Date(NEXT_WEEK_START.getTime() - 1),
    status: 'paid',
    totals: { netPayable: 30250 },
    entryCount: 1,
    approvedBy: admin._id,
    approvedAt: new Date(),
    payout: {
      provider: 'bank_file',
      utr: 'UTR1',
      reference: 'YULO-X-1',
      attempts: 2,
      batchId: new mongoose.Types.ObjectId(),
      markedPaidBy: admin._id,
      beneficiary: { fingerprint: 'f'.repeat(64), accountNumberLast4: '3333' },
    },
  });
  const headers = as(owner, 'restaurant_owner');
  const detail = await srv.get(`/api/owner/${restaurant._id}/settlements/${s._id}`, headers);
  const list = await srv.get(`/api/owner/${restaurant._id}/settlements`, headers);
  for (const res of [detail, list]) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.doesNotMatch(JSON.stringify(res.body), /approvedBy|markedPaidBy|batchId|attempts|generationLock|beneficiary|fingerprint/);
  }
  assert.equal(detail.body.data.settlement.payout.utr, 'UTR1');
  assert.equal(list.body.data.settlements[0].totals.netPayable, 30250);
});

// ── Bank account verification token ──────────────────────────────────────────

test('admin verify/reject must name the submission they checked; a newer one is refused', async () => {
  // A not-yet-verified account: a resubmission replaces it (a verified one would become a
  // change request instead — B12, test/b12-bank-requests.test.js).
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.status': 'pending_verification' } });
  const headers = as(owner, 'restaurant_owner');
  const details = (n) => ({ accountHolderName: 'Spice Route Foods', accountNumber: n, confirmAccountNumber: n, ifsc: 'HDFC0001234', accountType: 'current' });
  await srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, { headers, body: details('123456789012') });
  const seen = (await srv.get(`/api/admin/stores/${restaurant._id}/payout-account`, as(admin, 'admin'))).body.data.account;

  // The owner swaps the account after the admin opened (and revealed) the first one.
  await new Promise((r) => setTimeout(r, 5));
  await srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, { headers, body: details('999900001111') });

  const url = `/api/admin/stores/${restaurant._id}/payout-account`;
  const missing = await srv.request('PATCH', `${url}/verify`, { headers: as(admin, 'admin'), body: {} });
  assert.equal(missing.status, 400);
  const stale = await srv.request('PATCH', `${url}/verify`, { headers: as(admin, 'admin'), body: { submittedAt: seen.submittedAt } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'ACCOUNT_CHANGED');
  const staleReject = await srv.request('PATCH', `${url}/reject`, {
    headers: as(admin, 'admin'),
    body: { reason: 'Name mismatch', submittedAt: seen.submittedAt },
  });
  assert.equal(staleReject.body.code, 'ACCOUNT_CHANGED');
  assert.equal((await Restaurant.findById(restaurant._id).lean()).payoutAccount.status, 'pending_verification');

  const current = (await srv.get(url, as(admin, 'admin'))).body.data.account;
  const ok = await srv.request('PATCH', `${url}/verify`, { headers: as(admin, 'admin'), body: { submittedAt: current.submittedAt } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.account.accountNumberLast4, '1111');
});

// ── Rider payouts: legacy (UTC-keyed) rows ───────────────────────────────────

test('rider payouts: deliveries a paid legacy row covered are not paid again; legacy rows are never payable', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi' });
  const delivered = (deliveredAt, basePay) =>
    Order.create({
      restaurantId: restaurant._id,
      type: 'delivery',
      items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
      subtotal: 300,
      status: 'delivered',
      deliveredAt,
      deliveryAssignment: { partnerId: partner._id, status: 'delivered', earningsBreakdown: { basePay, distancePay: 0, tip: 0 } },
    });
  // IST week: Sun 27 Sep 18:30 UTC → Sun 4 Oct 18:29 UTC. The old code's UTC week: Mon 28 Sep 00:00 → Sun 4 Oct 23:59 UTC.
  await delivered(new Date('2026-09-30T10:00:00Z'), 20); // in both
  await delivered(new Date('2026-09-27T20:00:00Z'), 25); // IST week only (Mon 01:30 IST)
  const legacyPaid = await Payout.create({
    partnerId: partner._id,
    periodType: 'weekly',
    periodStart: new Date('2026-09-28T00:00:00Z'),
    periodEnd: new Date('2026-10-04T23:59:59.999Z'),
    perDeliveryRate: 30,
    netPayable: 20,
    status: 'paid',
  });
  const legacyPending = await Payout.create({
    partnerId: partner._id,
    periodType: 'weekly',
    periodStart: new Date('2026-09-21T00:00:00Z'),
    periodEnd: new Date('2026-09-27T23:59:59.999Z'),
    perDeliveryRate: 30,
    netPayable: 25,
    incentives: 50,
    status: 'pending',
  });

  const ist = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', new Date('2026-09-30T10:00:00Z'));
  assert.equal(ist.periodStart.toISOString(), '2026-09-27T18:30:00.000Z');
  assert.equal(ist.deliveriesCount, 1, 'only the delivery the paid legacy row did not cover');
  assert.equal(ist.netPayable, 25);
  assert.equal(String((await Payout.findById(legacyPaid._id).lean()).status), 'paid', 'history kept');

  const pay = await payoutService.markPayoutsPaid([legacyPending._id]);
  assert.equal(pay.modifiedCount, 0);
  assert.match(pay.skipped[0].reason, /Old-format period/);
  await assert.rejects(payoutService.adjustPayout(legacyPending._id, { incentives: 1, adjustedBy: admin._id }), (e) => e.code === 'NOT_PAYABLE');

  // The migration moves the admin's incentive onto the current row and removes the old one.
  const dry = await migratePayoutPeriods({ apply: false, log: () => {} });
  assert.equal(dry.carriedOver, 1);
  assert.ok(await Payout.exists({ _id: legacyPending._id }), 'dry run changes nothing');
  const applied = await migratePayoutPeriods({ apply: true, log: () => {} });
  assert.equal(applied.carriedOver, 1);
  assert.equal(applied.keptPaid, 1);
  assert.equal(await Payout.exists({ _id: legacyPending._id }), null);
  const { settlementCycle } = await getActiveSettings();
  const target = await Payout.findOne({
    partnerId: partner._id,
    periodType: 'weekly',
    periodStart: weekBounds(new Date('2026-09-24T12:00:00Z'), settlementCycle).start,
  }).lean();
  assert.equal(target.incentives, 50);
  assert.equal((await migratePayoutPeriods({ apply: true, log: () => {} })).carriedOver, 0, 're-runnable');
});

test('a legacy pending row with nothing entered by an admin is superseded by the current row', async () => {
  const partner = await DeliveryPartner.create({ phone: '9222222222', fullName: 'Asha' });
  await Payout.create({
    partnerId: partner._id,
    periodType: 'weekly',
    periodStart: new Date('2026-09-28T00:00:00Z'),
    periodEnd: new Date('2026-10-04T23:59:59.999Z'),
    perDeliveryRate: 30,
    status: 'pending',
  });
  await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', new Date('2026-09-30T10:00:00Z'));
  const rows = await Payout.find({ partnerId: partner._id }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].periodStart.toISOString(), '2026-09-27T18:30:00.000Z');
});

// ── Demo seed guard ───────────────────────────────────────────────────────────

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

test('demo seed refuses a non-local database unless told it is staging', async () => {
  for (const uri of ['mongodb+srv://cluster0.example.invalid/yulo', 'mongodb://10.1.2.3:27017/yulo']) {
    const run = await runSeed({ NODE_ENV: 'development', MONGODB_URI: uri });
    assert.equal(run.status, 1, uri);
    assert.match(run.stderr, /not a database on this machine/);
  }
  // A multi-host string with a remote member never gets as far as connecting either.
  assert.equal((await runSeed({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost:1,db.example.invalid:2/x' })).status, 1);
});

test('demo seed --generate settles only the demo restaurant', async () => {
  const { previousWeekStart } = settlementService;
  const lastWeek = previousWeekStart(new Date(), (await getActiveSettings()).settlementCycle);
  const real = await row('credit', 7777, { eligibleAt: new Date(lastWeek.getTime() + 24 * 60 * 60 * 1000) });

  const run = await runSeed({ MONGODB_URI: `${mongo.uri}yulo_test`, NODE_ENV: 'development' }, ['--generate']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Settlement generated/);
  assert.equal((await RestaurantLedgerEntry.findById(real._id).lean()).settlementId, null, 'a real restaurant is untouched');
  assert.equal(await RestaurantSettlement.countDocuments({ restaurantId: restaurant._id }), 0);
});
