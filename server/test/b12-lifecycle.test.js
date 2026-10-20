// B12 — the manual payout lifecycle (Figma M1–M5, D1–D6): schedule (= approve) with a release
// date, change date, release (attempt reference, beneficiary unchanged since scheduling, amount
// confirmation), mark as paid (bank reference + date credited), mark as failed (reason code, the
// money stays eligible), reschedule (the failure stays recorded), hold with a reason code and a
// staff-only note (clears the date), update reason, release hold; races; what the owner sees.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const settlementService = await import('../services/settlement.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens } = await import('../services/auth.service.js');

// Week of Mon 5 Oct 2026 (IST); the business clock sits on Tue 20 Oct, after it.
const WEEK = new Date('2026-10-07T06:00:00Z');
const CLOCK = new Date('2026-10-20T06:00:00Z');
const IST_DAY = (ymd) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - 5.5 * 60 * 60 * 1000);

let mongo;
let srv;
let owner;
let admin;
let restaurant;
let s;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), RestaurantSettlement.init()]);
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
  settlementService.__setSettlementClockForTests(() => CLOCK);
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Annapurna Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    payoutAccount: {
      accountHolderName: 'Annapurna Kitchen',
      accountNumberEncrypted: encryptField('123456784417'),
      accountNumberLast4: '4417',
      ifsc: 'HDFC0001234',
      accountType: 'current',
      status: 'verified',
      submittedAt: new Date('2026-09-01T00:00:00Z'),
      verifiedAt: new Date('2026-09-02T00:00:00Z'),
    },
  });
  await RestaurantLedgerEntry.create({
    restaurantId: restaurant._id,
    type: 'adjustment',
    direction: 'credit',
    amountPaise: 227814,
    breakdown: { kind: 'correction', gst: 0 },
    eligibleAt: WEEK,
    clearsAt: WEEK,
    note: 'week earnings',
  });
  ({ settlements: [s] } = await settlementService.generateWeeklySettlements(WEEK));
});

const as = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const act = (action, body) =>
  srv.request('PATCH', `/api/admin/finance/payouts/${s._id}/${action}`, { headers: as(admin, 'admin'), body: body ?? {} });
const ownerView = async () => {
  const res = await srv.get(`/api/owner/${restaurant._id}/settlements/${s._id}`, as(owner, 'restaurant_owner'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.settlement;
};
const fresh = () => RestaurantSettlement.findById(s._id).lean();
const ok = (res, status = 200) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body.data;
};

test('schedule → change date → release → mark as paid; the owner sees every step', async () => {
  assert.equal(s.status, 'draft');
  assert.equal((await ownerView()).transfer.status, 'not_scheduled');

  const past = await act('schedule', { scheduledFor: '2026-10-19' });
  assert.equal(past.status, 400, 'the release date cannot be in the past');

  const scheduled = ok(await act('schedule', { scheduledFor: '2026-10-26' })).settlement;
  assert.equal(scheduled.status, 'approved');
  assert.equal(new Date(scheduled.payout.scheduledFor).getTime(), IST_DAY('2026-10-26').getTime(), 'local midnight IST');
  let o = await ownerView();
  assert.equal(o.transfer.status, 'scheduled');
  assert.equal(o.ownerView.status, 'Scheduled');
  assert.match(o.ownerView.message, /Scheduled · Mon 26 Oct 2026/);

  ok(await act('schedule-date', { scheduledFor: '2026-10-28' }));
  assert.equal(new Date((await fresh()).payout.scheduledFor).getTime(), IST_DAY('2026-10-28').getTime());

  const wrongAmount = await act('release', { expectedNetPaise: 100 });
  assert.equal(wrongAmount.status, 409);
  assert.equal(wrongAmount.body.code, 'AMOUNT_CHANGED');
  const released = ok(await act('release', { expectedNetPaise: 227814 })).settlement;
  assert.equal(released.status, 'processing');
  assert.match(released.payout.attemptRef, /^YULO-ATT-\d{8}-\d{3}$/);
  o = await ownerView();
  assert.equal(o.ownerView.status, 'Processing');
  assert.match(o.ownerView.message, /₹2,278\.14 has been sent to the bank/);

  assert.equal((await act('mark-paid', {})).status, 400, 'bank reference required');
  const future = await act('mark-paid', { bankReference: 'UTR20261028', creditedAt: '2030-01-01' });
  assert.equal(future.status, 400, 'date credited cannot be in the future');
  const paid = ok(await act('mark-paid', { bankReference: 'UTR20261028' })).settlement;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payout.utr, 'UTR20261028');
  o = await ownerView();
  assert.equal(o.transfer.status, 'paid');
  assert.equal(o.transfer.bankReference, 'UTR20261028');
  assert.match(o.ownerView.message, /Reference UTR20261028/);

  const actions = (await AdminActivityLog.find({ targetId: s._id }).sort({ createdAt: 1 }).lean()).map((l) => l.action);
  assert.deepEqual(actions, ['settlement.schedule', 'settlement.change_date', 'settlement.release', 'settlement.mark_paid']);
});

test('mark as failed keeps the money eligible; reschedule keeps the failure; a new attempt pays', async () => {
  ok(await act('schedule', { scheduledFor: '2026-10-21' }));
  const first = ok(await act('release')).settlement.payout.attemptRef;

  assert.equal((await act('mark-failed', { reason: 'nope' })).status, 400);
  assert.equal((await act('mark-failed', { reason: 'other' })).status, 400, 'other needs a note');
  const failed = ok(await act('mark-failed', { reason: 'bank_rejected_credit' })).settlement;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.totals.netPayable, 227814, 'same statement, same money — no fee');
  assert.equal(failed.payout.lastFailure.reason, 'bank_rejected_credit');
  assert.equal(failed.payout.lastFailure.attemptRef, first);
  let o = await ownerView();
  assert.equal(o.eligibility, 'eligible');
  assert.equal(o.transfer.status, 'failed');
  assert.match(o.ownerView.message, /remains unpaid and retained for payout/);

  assert.equal((await act('release')).body.code, 'NOT_SCHEDULED', 'no automatic retry');
  const again = ok(await act('reschedule', { scheduledFor: '2026-10-28' })).settlement;
  assert.equal(again.status, 'approved');
  assert.equal(again.payout.attemptRef, null);
  assert.equal(again.payout.lastFailure.reason, 'bank_rejected_credit', 'the failure stays recorded');
  o = await ownerView();
  assert.equal(o.transfer.status, 'scheduled');
  assert.match(o.ownerView.message, /A previous attempt failed on/);

  const second = ok(await act('release')).settlement.payout.attemptRef;
  assert.notEqual(second, first);
  ok(await act('mark-paid', { bankReference: 'UTR-RETRY-1' }));
  assert.equal((await fresh()).payout.history.length, 1);
});

test('release is refused once the account differs from the one scheduled; change date re-confirms it', async () => {
  ok(await act('schedule', { scheduledFor: '2026-10-21' }));
  // A verified change replaced the account after scheduling.
  await Restaurant.updateOne(
    { _id: restaurant._id },
    { $set: { 'payoutAccount.accountNumberEncrypted': encryptField('999988887777'), 'payoutAccount.accountNumberLast4': '7777' } }
  );
  const refused = await act('release');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'BENEFICIARY_CHANGED');

  ok(await act('schedule-date', { scheduledFor: '2026-10-22' }));
  const released = ok(await act('release')).settlement;
  assert.equal(released.payout.beneficiary.accountNumberLast4, '7777');
});

test('hold: reason code + staff-only note, clears the date; update reason; release hold → eligible, not scheduled', async () => {
  ok(await act('schedule', { scheduledFor: '2026-10-21' }));
  assert.equal((await act('hold', { reason: 'bogus' })).status, 400);
  const held = ok(await act('hold', { reason: 'dispute_review', note: 'Owner disputes two orders — internal' })).settlement;
  assert.equal(held.status, 'on_hold');
  assert.equal(held.payout.scheduledFor, null, 'holding a scheduled payout clears its date');

  const o = await ownerView();
  assert.equal(o.eligibility, 'on_hold');
  assert.equal(o.holdLabel, 'Dispute review');
  assert.equal(o.ownerView.status, 'On hold');
  const ownerJson = JSON.stringify(await srv.get(`/api/owner/${restaurant._id}/settlements`, as(owner, 'restaurant_owner')));
  assert.doesNotMatch(JSON.stringify(o) + ownerJson, /internal|holdNote/, 'the hold note is staff-only');

  assert.equal((await act('schedule', { scheduledFor: '2026-10-22' })).body.code, 'NOT_APPROVABLE', 'held payouts cannot be scheduled');
  ok(await act('hold-reason', { reason: 'bank_details_review', note: 'Checking IFSC' }));
  assert.equal((await fresh()).holdCode, 'bank_details_review');

  const back = ok(await act('release-hold')).settlement;
  assert.equal(back.status, 'draft');
  assert.equal(back.payout.scheduledFor, null);
  assert.equal((await ownerView()).transfer.status, 'not_scheduled');

  // Never once released.
  ok(await act('schedule', { scheduledFor: '2026-10-21' }));
  ok(await act('release'));
  assert.equal((await act('hold', { reason: 'other', note: 'too late' })).body.code, 'NOT_HOLDABLE');
});

test('races: release vs hold — exactly one wins; two mark-paid — one wins', async () => {
  ok(await act('schedule', { scheduledFor: '2026-10-21' }));
  const [release, hold] = await Promise.all([act('release'), act('hold', { reason: 'dispute_review' })]);
  const wins = [release, hold].filter((r) => r.status === 200);
  assert.equal(wins.length, 1, `${release.status}/${hold.status}`);
  const after = await fresh();
  assert.ok(['processing', 'on_hold'].includes(after.status));
  if (after.status === 'on_hold') {
    ok(await act('release-hold'));
    ok(await act('schedule', { scheduledFor: '2026-10-21' }));
    ok(await act('release'));
  }
  const [a, b] = await Promise.all([act('mark-paid', { bankReference: 'UTR-A-1' }), act('mark-paid', { bankReference: 'UTR-B-2' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('schedule needs an ended week and a verified account; legacy approve defaults to the next payout day', async () => {
  settlementService.__setSettlementClockForTests(() => new Date('2026-10-09T06:00:00Z')); // mid-week
  assert.equal((await act('schedule', { scheduledFor: '2026-10-21' })).body.code, 'WEEK_NOT_ENDED');
  settlementService.__setSettlementClockForTests(() => CLOCK);

  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.status': 'pending_verification' } });
  assert.equal((await act('schedule', { scheduledFor: '2026-10-21' })).body.code, 'PAYOUT_ACCOUNT_NOT_VERIFIED');
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.status': 'verified' } });

  // Pre-B12 approve: scheduled for the next payoutDayOfWeek (Wednesday by default) on/after Tue 20 Oct.
  const res = await srv.request('PATCH', `/api/admin/finance/settlements/${s._id}/approve`, { headers: as(admin, 'admin') });
  const approved = ok(res).settlement;
  assert.equal(new Date(approved.payout.scheduledFor).getTime(), IST_DAY('2026-10-21').getTime());
});

test('only admins act on payouts', async () => {
  const res = await srv.request('PATCH', `/api/admin/finance/payouts/${s._id}/schedule`, {
    headers: as(owner, 'restaurant_owner'),
    body: { scheduledFor: '2026-10-21' },
  });
  assert.equal(res.status, 403);
  assert.equal((await fresh()).status, 'draft');
});
