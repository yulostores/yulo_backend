// B9 (bank-file payouts) — paying approved settlements through a weekly net-banking bulk
// upload: batching (one batch per settlement, ever), the file (decrypted accounts, audited),
// reconciliation from the bank's response file (paid / failed / returned, replay-safe),
// retry vs carry-forward, cancelling an un-uploaded batch, and the provider registry.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, createVersion } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const payoutBatchService = await import('../services/payoutBatch.service.js');
const settlementService = await import('../services/settlement.service.js');
const { getPayoutProvider } = await import('../services/payoutProviders/index.js');
const { getBankFileFormat, parseBankResponse } = await import('../config/bankFileFormats.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: PayoutBatch } = await import('../models/PayoutBatch.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let admin;
let owner;
let rA;
let rB;
let rC;
let sA;
let sB;
let sC;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantSettlement.init(), RestaurantLedgerEntry.init()]);
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

const account = (number, holder) => ({
  accountHolderName: holder,
  accountNumberEncrypted: encryptField(number),
  accountNumberLast4: number.slice(-4),
  ifsc: 'HDFC0001234',
  accountType: 'current',
  status: 'verified',
});

const approvedSettlement = (restaurant, netPayable) =>
  RestaurantSettlement.create({
    restaurantId: restaurant._id,
    periodStart: new Date('2026-10-04T18:30:00Z'),
    periodEnd: new Date('2026-10-11T18:29:59.999Z'),
    status: 'approved',
    totals: { netPayable },
    entryCount: 1,
  });

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  const base = { ownerId: owner._id, location: { type: 'Point', coordinates: [77.59, 12.97] }, approvalStatus: 'active' };
  rA = await Restaurant.create({ ...base, name: 'Alpha Kitchen', email: 'alpha@test.local', payoutAccount: account('111122223333', 'Alpha Foods') });
  rB = await Restaurant.create({ ...base, name: 'Beta Bites', payoutAccount: account('444455556666', 'Beta Bites, LLP') });
  rC = await Restaurant.create({ ...base, name: 'Gamma', payoutAccount: { ...account('777788889999', 'Gamma'), status: 'pending_verification' } });
  sA = await approvedSettlement(rA, 30250);
  sB = await approvedSettlement(rB, 27355);
  sC = await approvedSettlement(rC, 10000);
});

const adminHeaders = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });
const fresh = (s) => RestaurantSettlement.findById(s._id).lean();

const createBatch = async (body = {}) => {
  const res = await srv.request('POST', '/api/admin/finance/payout-batches', { headers: adminHeaders(), body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const responseCsv = (rows) =>
  ['Payment Reference,Status,UTR,Reason', ...rows.map((r) => [r.reference, r.status, r.utr ?? '', r.reason ?? ''].join(','))].join('\n');
const reconcile = (batchId, body) =>
  srv.request('POST', `/api/admin/finance/payout-batches/${batchId}/reconcile`, { headers: adminHeaders(), body });

// ── Batch & file ──────────────────────────────────────────────────────────────

test('batch: approved settlements with verified accounts are claimed once; unverified ones are skipped', async () => {
  const { batch, skipped } = await createBatch();
  assert.equal(batch.count, 2);
  assert.equal(batch.totalPaise, 30250 + 27355);
  assert.deepEqual(skipped.map((s) => String(s.settlementId)), [String(sC._id)]);

  const a = await fresh(sA);
  assert.equal(a.status, 'processing');
  assert.equal(a.payout.provider, 'bank_file');
  assert.match(a.payout.reference, /^YULO-[0-9A-F]{24}-1$/);
  assert.equal((await fresh(sC)).status, 'approved', 'left for when the account is verified');

  const again = await srv.request('POST', '/api/admin/finance/payout-batches', { headers: adminHeaders(), body: {} });
  assert.equal(again.status, 409, 'nothing left to put on a second batch (only the unverified one)');
});

test('two batches created at once never share a settlement', async () => {
  await Restaurant.updateOne({ _id: rC._id }, { $set: { 'payoutAccount.status': 'verified' } });
  const results = await Promise.allSettled([
    payoutBatchService.createBatch({ adminId: admin._id }),
    payoutBatchService.createBatch({ adminId: admin._id }),
  ]);
  const ids = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value.batch.settlementIds.map(String));
  assert.equal(ids.length, new Set(ids).size, 'no settlement on two batches');
  assert.equal(ids.length, 3);
});

test('file: the bank upload carries full decrypted accounts, IFSC, amounts, IMPS mode; download audited', async () => {
  const { batch } = await createBatch();
  const res = await srv.get(`/api/admin/finance/payout-batches/${batch._id}/file`, adminHeaders());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="yulo-payouts-.*\.csv"/);

  const lines = res.body.trim().split('\n');
  assert.equal(lines[0], 'Payment Reference,Beneficiary Name,Beneficiary Account Number,IFSC,Amount,Payment Mode,Beneficiary Email,Beneficiary Mobile,Narration');
  assert.equal(lines.length, 3);
  const alpha = lines.find((l) => l.includes('Alpha Foods'));
  assert.match(alpha, /111122223333,HDFC0001234,302\.50,IMPS,alpha@test\.local/);
  assert.ok(res.body.includes('"Beta Bites, LLP"'), 'commas in names are quoted');
  assert.ok(!res.body.includes('777788889999'), 'unverified account never in the file');

  const log = await AdminActivityLog.findOne({ action: 'payout_batch.download' }).lean();
  assert.ok(log);
  assert.doesNotMatch(JSON.stringify(log), /111122223333/);
  assert.equal((await PayoutBatch.findById(batch._id).lean()).status, 'downloaded');

  const asOwner = await srv.get(`/api/admin/finance/payout-batches/${batch._id}/file`, {
    authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}`,
  });
  assert.equal(asOwner.status, 403);
});

test('amounts above the IMPS limit go NEFT', async () => {
  await RestaurantSettlement.updateOne({ _id: sA._id }, { $set: { 'totals.netPayable': 60_000_000 } }); // ₹6,00,000
  const { batch } = await createBatch({ settlementIds: [String(sA._id)] });
  const file = await payoutBatchService.buildBatchFile(batch._id, admin._id);
  assert.match(file.content, /600000\.00,NEFT/);
});

// ── Reconciliation ────────────────────────────────────────────────────────────

test('reconcile from the bank response file: paid → paid with UTR, failed → failed; replay changes nothing', async () => {
  const { batch } = await createBatch();
  const [a, b] = await Promise.all([fresh(sA), fresh(sB)]);
  const csv = responseCsv([
    { reference: a.payout.reference, status: 'SUCCESS', utr: 'HDFCN52026101100001' },
    { reference: b.payout.reference, status: 'Rejected', reason: 'Invalid account number' },
  ]);

  const first = await reconcile(batch._id, { csv });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.summary.paid, 1);
  assert.equal(first.body.data.summary.failed, 1);
  assert.equal(first.body.data.batch.status, 'reconciled');

  const paidA = await fresh(sA);
  assert.equal(paidA.status, 'paid');
  assert.equal(paidA.payout.utr, 'HDFCN52026101100001');
  const failedB = await fresh(sB);
  assert.equal(failedB.status, 'failed');
  assert.match(failedB.payout.failureReason, /Invalid account number/);

  const replay = await reconcile(batch._id, { csv });
  assert.equal(replay.body.data.summary.unchanged, 2);
  assert.equal(replay.body.data.summary.paid, 0);

  const conflict = await reconcile(batch._id, { rows: [{ reference: a.payout.reference, status: 'paid', utr: 'OTHERUTR999' }] });
  assert.equal(conflict.body.data.summary.conflicts.length, 1);
  assert.equal((await fresh(sA)).payout.utr, 'HDFCN52026101100001', 'never overwritten');
});

test('a payment returned after it was reported paid → failed; unknown references are reported', async () => {
  const { batch } = await createBatch();
  const a = await fresh(sA);
  await reconcile(batch._id, { rows: [{ reference: a.payout.reference, status: 'paid', utr: 'UTR0001' }] });
  assert.equal((await PayoutBatch.findById(batch._id).lean()).status, 'partially_reconciled', 'B still awaiting');

  const res = await reconcile(batch._id, {
    rows: [
      { reference: a.payout.reference, status: 'returned', reason: 'Account closed' },
      { reference: 'YULO-NOPE00-1', status: 'paid', utr: 'UTR0002' },
    ],
  });
  assert.equal(res.body.data.summary.returned, 1);
  assert.equal(res.body.data.summary.unmatched.length, 1);
  const returned = await fresh(sA);
  assert.equal(returned.status, 'failed');
  assert.match(returned.payout.failureReason, /Returned: Account closed/);
});

// ── Failed payouts: retry or carry forward ────────────────────────────────────

test('retry: a failed payout goes on the next batch with a new reference', async () => {
  const { batch } = await createBatch({ settlementIds: [String(sB._id)] });
  const first = (await fresh(sB)).payout.reference;
  await reconcile(batch._id, { rows: [{ reference: first, status: 'failed', reason: 'Timeout' }] });

  const res = await srv.request('PATCH', `/api/admin/finance/settlements/${sB._id}/retry-payout`, { headers: adminHeaders() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.settlement.status, 'approved');

  await createBatch({ settlementIds: [String(sB._id)] });
  const second = (await fresh(sB)).payout.reference;
  assert.notEqual(second, first);
  assert.match(second, /-2$/);
  const oldBatch = await payoutBatchService.getBatchDetail(batch._id);
  assert.equal(oldBatch.settlements.length, 1, 'the first batch still lists it in its history');
});

test('carry forward: a failed payout\'s amount lands in the next settlement — and can no longer be retried', async () => {
  const { batch } = await createBatch({ settlementIds: [String(sB._id)] });
  await reconcile(batch._id, { rows: [{ reference: (await fresh(sB)).payout.reference, status: 'failed', reason: 'Wrong IFSC' }] });

  const res = await srv.request('PATCH', `/api/admin/finance/settlements/${sB._id}/carry-forward`, { headers: adminHeaders() });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await fresh(sB)).status, 'carried_forward');
  const credit = await RestaurantLedgerEntry.findOne({ restaurantId: rB._id, type: 'carry_forward' }).lean();
  assert.equal(credit.direction, 'credit');
  assert.equal(credit.amountPaise, 27355);
  assert.equal(credit.settlementId, null, 'waits for the next week');

  const retry = await srv.request('PATCH', `/api/admin/finance/settlements/${sB._id}/retry-payout`, { headers: adminHeaders() });
  assert.equal(retry.status, 409, 'never both');
  const twice = await srv.request('PATCH', `/api/admin/finance/settlements/${sB._id}/carry-forward`, { headers: adminHeaders() });
  assert.equal(twice.status, 409);

  const { settlements } = await settlementService.generateWeeklySettlements(new Date());
  const next = settlements.find((s) => String(s.restaurantId) === String(rB._id));
  assert.equal(next.totals.netPayable, 27355);
});

// ── Cancel ────────────────────────────────────────────────────────────────────

test('cancel: only with confirmation that the file was not uploaded; settlements go back to approved', async () => {
  const { batch } = await createBatch();
  const unconfirmed = await srv.request('POST', `/api/admin/finance/payout-batches/${batch._id}/cancel`, { headers: adminHeaders(), body: {} });
  assert.equal(unconfirmed.status, 400);

  const ok = await srv.request('POST', `/api/admin/finance/payout-batches/${batch._id}/cancel`, {
    headers: adminHeaders(),
    body: { confirmNotUploaded: true },
  });
  assert.equal(ok.status, 200);
  const a = await fresh(sA);
  assert.equal(a.status, 'approved');
  assert.equal(a.payout.batchId, null);

  const { batch: second } = await createBatch();
  await reconcile(second._id, { rows: [{ reference: (await fresh(sA)).payout.reference, status: 'paid', utr: 'UTR777' }, { reference: (await fresh(sB)).payout.reference, status: 'paid', utr: 'UTR778' }] });
  const late = await srv.request('POST', `/api/admin/finance/payout-batches/${second._id}/cancel`, {
    headers: adminHeaders(),
    body: { confirmNotUploaded: true },
  });
  assert.equal(late.status, 409, 'a reconciled batch cannot be cancelled');
});

// ── Providers & settings ──────────────────────────────────────────────────────

test('provider registry: manual and bank_file available; razorpayx/route not yet', async () => {
  assert.equal((await getPayoutProvider('bank_file').ensureBeneficiary({ _id: rC._id })).ready, false);
  assert.equal((await getPayoutProvider('manual').ensureBeneficiary({ _id: rA._id })).ready, true);
  assert.throws(() => getPayoutProvider('razorpayx'), (e) => e.code === 'PAYOUT_PROVIDER_UNAVAILABLE');

  await createVersion({ patch: { payoutProvider: 'bank_file' } }, admin._id);
  await assert.rejects(
    createVersion({ patch: { payoutBankFileFormat: 'some_unknown_bank' } }, admin._id),
    (e) => e.code === 'VALIDATION_ERROR'
  );
});

test('bank response parser: finds columns by name, handles quotes, flags unknown statuses', () => {
  const csv = 'UTR,Reason,Status,Payment Reference\r\n"N1234",,"Success","YULO-AAAAAA-1"\n,"Bank, down",FAILED,YULO-BBBBBB-1\n,,On hold,YULO-CCCCCC-1\n';
  const rows = parseBankResponse(getBankFileFormat('generic_csv'), csv);
  assert.deepEqual(
    rows.map((r) => [r.reference, r.status, r.utr, r.reason]),
    [
      ['YULO-AAAAAA-1', 'paid', 'N1234', null],
      ['YULO-BBBBBB-1', 'failed', null, 'Bank, down'],
      ['YULO-CCCCCC-1', 'unknown', null, null],
    ]
  );
  assert.throws(() => parseBankResponse(getBankFileFormat('generic_csv'), 'A,B\n1,2'), /must have/);
});
