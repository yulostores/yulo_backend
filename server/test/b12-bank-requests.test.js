// B12 task 3 — bank account change requests. A verified account stays in force while the owner's
// change is reviewed; the admin verifies (it replaces the account), rejects, or asks for
// information; decisions name the request they checked; the cross-restaurant "Bank requests"
// list with the payout each request affects; reveal of the requested number; nothing leaks.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { decryptField } = await import('../utils/fieldEncryption.js');
const payoutAccountService = await import('../services/payoutAccount.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens } = await import('../services/auth.service.js');

const OLD = '123456789012';
const NEW = '999988887777';
const details = (number, extra = {}) => ({
  accountHolderName: 'Spice Route Foods',
  accountNumber: number,
  confirmAccountNumber: number,
  ifsc: 'HDFC0001234',
  bankName: 'HDFC Bank',
  branch: 'MG Road',
  accountType: 'current',
  ...extra,
});

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
    approvalStatus: 'active',
    isActive: true,
  });
});

const as = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const ownerHeaders = () => as(owner, 'restaurant_owner');
const adminHeaders = () => as(admin, 'admin');
const ownerPut = (body, user = owner) =>
  srv.request('PUT', `/api/owner/${restaurant._id}/payout-account`, { headers: as(user, 'restaurant_owner'), body });
const adminUrl = (suffix = '') => `/api/admin/stores/${restaurant._id}/payout-account${suffix}`;
const adminAccount = async () => (await srv.get(adminUrl(), adminHeaders())).body.data.account;
const stored = () =>
  Restaurant.findById(restaurant._id)
    .select('+payoutAccount.accountNumberEncrypted +payoutAccount.pendingChange.accountNumberEncrypted')
    .lean();

// An account the admin has verified — the starting point of every change request.
const verifiedAccount = async () => {
  assert.equal((await ownerPut(details(OLD))).status, 200);
  const res = await srv.request('PATCH', adminUrl('/verify'), {
    headers: adminHeaders(),
    body: { submittedAt: (await adminAccount()).submittedAt },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'payoutAccount.providerFundAccountId': 'fa_old' } });
};

test('a change to a verified account is a request: the verified account stays in force, nothing leaks', async () => {
  await verifiedAccount();
  const res = await ownerPut(details(NEW, { ifsc: 'icic0001234' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { account, changeRequested } = res.body.data;
  assert.equal(changeRequested, true);
  assert.match(res.body.message, /verified account stays in use/);
  assert.equal(account.status, 'verified');
  assert.equal(account.accountNumberLast4, '9012');
  assert.equal(account.hasPendingChange, true);
  assert.deepEqual(
    { status: account.pendingChange.status, last4: account.pendingChange.accountNumberLast4, masked: account.pendingChange.accountNumberMasked, ifsc: account.pendingChange.ifsc },
    { status: 'in_review', last4: '7777', masked: 'XXXXXX7777', ifsc: 'ICIC0001234' }
  );

  const doc = await stored();
  assert.equal(decryptField(doc.payoutAccount.accountNumberEncrypted), OLD, 'live account unchanged');
  assert.equal(decryptField(doc.payoutAccount.pendingChange.accountNumberEncrypted), NEW, 'request stored encrypted');
  assert.equal(doc.payoutAccount.providerFundAccountId, 'fa_old');

  // Neither number nor ciphertext reaches the owner, the admin store view or a public read.
  const reads = [
    await srv.get(`/api/owner/${restaurant._id}/payout-account`, ownerHeaders()),
    await srv.get(`/api/admin/stores/${restaurant._id}`, adminHeaders()),
    await srv.get(adminUrl(), adminHeaders()),
    await srv.get(`/api/restaurants/${restaurant._id}`),
  ];
  for (const r of reads) {
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const body = JSON.stringify(r.body);
    assert.doesNotMatch(body, new RegExp(`${OLD}|${NEW}`));
    assert.doesNotMatch(body, /accountNumberEncrypted/);
  }
  // The public read keeps only an empty skeleton of the hidden field — no values.
  assert.doesNotMatch(JSON.stringify(reads[3].body), /7777|9012|ICIC0001234|HDFC0001234|in_review|Spice Route Foods/, 'public read carries no bank data');
});

test('resubmitting the request is a no-op; resubmitting the verified details withdraws it; before verification a change still replaces', async () => {
  await verifiedAccount();
  await ownerPut(details(NEW));
  const before = (await stored()).payoutAccount.pendingChange.requestedAt;

  const again = await ownerPut(details(NEW));
  assert.equal(again.body.data.changed, false);
  assert.equal((await stored()).payoutAccount.pendingChange.requestedAt.getTime(), before.getTime());

  const withdrawn = await ownerPut(details(OLD));
  assert.equal(withdrawn.body.data.changed, true);
  assert.equal(withdrawn.body.data.account.pendingChange, null);
  assert.equal(withdrawn.body.data.account.status, 'verified');
  assert.equal((await payoutAccountService.countOpenBankRequests()).open, 0);
});

test('admin list: open requests across restaurants with the payout each affects, and counts', async () => {
  await verifiedAccount();
  await ownerPut(details(NEW));
  const scheduledFor = new Date('2026-10-12T00:00:00.000Z');
  // The restaurant's open (scheduled) payout — written raw: only the fields this list reads.
  await RestaurantSettlement.collection.insertOne({
    restaurantId: restaurant._id,
    periodStart: new Date('2026-09-27T18:30:00.000Z'),
    periodEnd: new Date('2026-10-04T18:29:59.999Z'),
    status: 'approved',
    totals: { netPayable: 227814 },
    payout: { scheduledFor },
  });

  const anon = await srv.get('/api/admin/bank-requests');
  assert.equal(anon.status, 401);
  assert.equal((await srv.get('/api/admin/bank-requests', ownerHeaders())).status, 403);

  const res = await srv.get('/api/admin/bank-requests', adminHeaders());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { requests, counts, total } = res.body.data;
  assert.equal(total, 1);
  assert.deepEqual(counts, { open: 1, awaitingRestaurant: 0 });
  const [row] = requests;
  assert.equal(row.restaurantName, 'Spice Route');
  assert.equal(row.currentAccountLast4, '9012');
  assert.equal(row.requestedAccountLast4, '7777');
  assert.equal(row.requestStatus, 'in_review');
  assert.deepEqual(
    { net: row.affects.netPayablePaise, transfer: row.affects.transferStatus, at: row.affects.scheduledFor },
    { net: 227814, transfer: 'scheduled', at: scheduledFor.toISOString() }
  );
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(`${OLD}|${NEW}|accountNumberEncrypted`));

  assert.equal((await srv.get('/api/admin/bank-requests?status=bogus', adminHeaders())).status, 400);
  assert.equal((await srv.get('/api/admin/bank-requests?status=rejected', adminHeaders())).body.data.total, 0);
});

test('ask for information → awaiting restaurant; the owner sees the message; resubmitting answers it', async () => {
  await verifiedAccount();
  await ownerPut(details(NEW));
  const seen = await adminAccount();

  const ask = await srv.request('PATCH', adminUrl('/change/request-info'), {
    headers: adminHeaders(),
    body: { message: 'Please upload a cancelled cheque for the new account', requestedAt: seen.pendingChange.requestedAt },
  });
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  assert.equal(ask.body.data.account.pendingChange.status, 'awaiting_restaurant');
  assert.deepEqual(await payoutAccountService.countOpenBankRequests(), { open: 1, awaitingRestaurant: 1 });

  const ownerView = (await srv.get(`/api/owner/${restaurant._id}/payout-account`, ownerHeaders())).body.data.account;
  assert.equal(ownerView.pendingChange.infoRequest.message, 'Please upload a cancelled cheque for the new account');
  assert.equal(ownerView.pendingChange.infoRequest.by, undefined, 'which admin asked is not shown');

  const answered = await ownerPut(details(NEW));
  assert.equal(answered.body.data.changed, true);
  assert.equal(answered.body.data.account.pendingChange.status, 'in_review');
  assert.deepEqual(await payoutAccountService.countOpenBankRequests(), { open: 1, awaitingRestaurant: 0 });
});

test('verify needs the request the admin checked; a newer one is refused; verifying replaces the account', async () => {
  await verifiedAccount();
  await ownerPut(details('111122223333'));
  const seen = await adminAccount();

  // The owner swaps the request after the admin opened it.
  await ownerPut(details(NEW));
  const missing = await srv.request('PATCH', adminUrl('/change/verify'), { headers: adminHeaders(), body: {} });
  assert.equal(missing.status, 400);
  const stale = await srv.request('PATCH', adminUrl('/change/verify'), {
    headers: adminHeaders(),
    body: { requestedAt: seen.pendingChange.requestedAt },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'ACCOUNT_CHANGED');
  assert.equal((await stored()).payoutAccount.accountNumberLast4, '9012', 'nothing applied');

  const current = await adminAccount();
  const ok = await srv.request('PATCH', adminUrl('/change/verify'), {
    headers: adminHeaders(),
    body: { requestedAt: current.pendingChange.requestedAt },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.account.status, 'verified');
  assert.equal(ok.body.data.account.accountNumberLast4, '7777');
  assert.equal(ok.body.data.account.pendingChange, null);

  const doc = await stored();
  assert.equal(decryptField(doc.payoutAccount.accountNumberEncrypted), NEW);
  assert.equal(doc.payoutAccount.providerFundAccountId, null, "the old account's beneficiary is dropped");
  assert.equal(String(doc.payoutAccount.verifiedBy), String(admin._id));

  const again = await srv.request('PATCH', adminUrl('/change/verify'), {
    headers: adminHeaders(),
    body: { requestedAt: current.pendingChange.requestedAt },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'NO_OPEN_REQUEST');

  const log = await AdminActivityLog.findOne({ action: 'payout_account.change_verify' }).lean();
  assert.deepEqual({ from: log.metadata.fromLast4, to: log.metadata.toLast4 }, { from: '9012', to: '7777' });
});

test('reject keeps the verified account and shows the reason; the owner can submit again', async () => {
  await verifiedAccount();
  await ownerPut(details(NEW));
  const seen = await adminAccount();
  const short = await srv.request('PATCH', adminUrl('/change/reject'), {
    headers: adminHeaders(),
    body: { reason: 'x', requestedAt: seen.pendingChange.requestedAt },
  });
  assert.equal(short.status, 400);

  const rejected = await srv.request('PATCH', adminUrl('/change/reject'), {
    headers: adminHeaders(),
    body: { reason: 'Name on the cheque does not match', requestedAt: seen.pendingChange.requestedAt },
  });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const account = rejected.body.data.account;
  assert.equal(account.status, 'verified');
  assert.equal(account.accountNumberLast4, '9012');
  assert.equal(account.pendingChange.status, 'rejected');
  assert.equal(account.pendingChange.rejectionReason, 'Name on the cheque does not match');
  assert.equal(account.hasPendingChange, false);
  assert.equal((await payoutAccountService.countOpenBankRequests()).open, 0);

  const retry = await ownerPut(details(NEW));
  assert.equal(retry.body.data.account.pendingChange.status, 'in_review');
  assert.equal(retry.body.data.account.pendingChange.rejectionReason, null);
});

test('admin reveal: current or requested number, audit-logged, never cached; owners and others are refused', async () => {
  await verifiedAccount();
  await ownerPut(details(NEW));

  const requested = await srv.request('POST', adminUrl('/reveal'), { headers: adminHeaders(), body: { which: 'requested' } });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.data.accountNumber, NEW);
  assert.equal(requested.headers.get('cache-control'), 'no-store');
  const current = await srv.request('POST', adminUrl('/reveal'), { headers: adminHeaders(), body: {} });
  assert.equal(current.body.data.accountNumber, OLD);
  assert.equal((await srv.request('POST', adminUrl('/reveal'), { headers: adminHeaders(), body: { which: 'other' } })).status, 400);

  const actions = (await AdminActivityLog.find({ action: /reveal/ }).lean()).map((l) => l.action).sort();
  assert.deepEqual(actions, ['payout_account.reveal', 'payout_account.reveal_requested']);

  // Another owner can neither read nor change it; an owner can't decide on it.
  assert.equal((await srv.get(`/api/owner/${restaurant._id}/payout-account`, as(otherOwner, 'restaurant_owner'))).status, 403);
  assert.equal((await ownerPut(details('444455556666'), otherOwner)).status, 403);
  const ownerDecides = await srv.request('PATCH', adminUrl('/change/verify'), {
    headers: ownerHeaders(),
    body: { requestedAt: (await adminAccount()).pendingChange.requestedAt },
  });
  assert.equal(ownerDecides.status, 403);

  // No request open → nothing to reveal.
  await ownerPut(details(OLD));
  assert.equal((await srv.request('POST', adminUrl('/reveal'), { headers: adminHeaders(), body: { which: 'requested' } })).status, 404);
});

test('the new account\'s proof: uploaded as bank_statement_change, becomes the verified bank_statement on verify', async () => {
  const { cloudinary } = await import('../services/upload.service.js');
  const { mock } = await import('node:test');
  mock.method(cloudinary.uploader, 'upload_stream', (opts, cb) => ({
    end: () => cb(null, { secure_url: `https://res.example.invalid/${opts.public_id}.pdf`, public_id: opts.public_id }),
  }));
  mock.method(cloudinary.uploader, 'destroy', async () => ({ result: 'ok' }));
  const upload = (type) => {
    const form = new FormData();
    form.append('type', type);
    form.append('document', new Blob([Buffer.from('%PDF-1.4 proof')], { type: 'application/pdf' }), 'cheque.pdf');
    return fetch(`${srv.base}/api/owner/${restaurant._id}/documents`, { method: 'POST', headers: ownerHeaders(), body: form });
  };
  try {
    // Seed the verified account's own proof, verified.
    await verifiedAccount();
    await Restaurant.updateOne(
      { _id: restaurant._id },
      { $push: { documents: { type: 'bank_statement', url: 'https://res.example.invalid/old.pdf', status: 'verified', uploadedAt: new Date() } } }
    );

    // No open change → the change proof is refused; the verified proof can't be replaced.
    assert.equal((await upload('bank_statement_change')).status, 409);
    assert.equal((await upload('bank_statement')).status, 409);

    assert.equal((await ownerPut(details(NEW))).status, 200);
    const up = await upload('bank_statement_change');
    assert.equal(up.status, 200, await up.text());

    const account = await adminAccount();
    assert.equal(account.proofDocument.status, 'verified', 'the live account keeps its own proof');
    assert.equal(account.pendingChange.proofDocument.status, 'pending', 'the request points at the new proof');
    const changeProofId = String(account.pendingChange.proofDocument._id);

    const verify = await srv.request('PATCH', adminUrl('/change/verify'), {
      headers: adminHeaders(),
      body: { requestedAt: account.pendingChange.requestedAt },
    });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    const docs = (await Restaurant.findById(restaurant._id).lean()).documents;
    const statements = docs.filter((d) => d.type === 'bank_statement');
    assert.equal(statements.length, 1);
    assert.equal(String(statements[0]._id), changeProofId);
    assert.equal(statements[0].status, 'verified');
    assert.equal(docs.some((d) => d.type === 'bank_statement_change'), false);
    assert.equal(verify.body.data.account.proofDocument.status, 'verified');
  } finally {
    mock.restoreAll();
  }
});
