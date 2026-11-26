// Paying restaurants any day, in full or in part (anytime mode), the daily / range report for the
// super admin and the restaurant, and the weekly statement's payment actions being retired.
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setPayoutModeForTests } = await import('../config/payoutMode.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: RestaurantPayment } = await import('../models/RestaurantPayment.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let seed;
let admin;
let owner;
let rid;
const oid = () => new mongoose.Types.ObjectId();
const ist = (s) => new Date(`${s}+05:30`);
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

before(async () => {
  __setPayoutModeForTests('anytime');
  mongo = await startMemoryMongo();
  srv = await startTestServer();
});
after(async () => {
  __setPayoutModeForTests(null);
  await srv?.close();
  await mongo?.stop();
});

const row = (over) => ({
  _id: oid(),
  restaurantId: rid,
  type: 'order_earning',
  direction: 'credit',
  amountPaise: 10000,
  eligibleAt: ist('2026-11-20T10:00:00'),
  clearsAt: ist('2026-11-20T10:00:00'),
  settlementId: null,
  createdAt: ist('2026-11-20T10:00:00'),
  ...over,
});

beforeEach(async () => {
  await mongo.clear();
  seed = await seedBasics();
  rid = seed.restaurant._id;
  const adminUser = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  admin = { authorization: `Bearer ${generateTokens(adminUser._id, 'admin').accessToken}` };
  owner = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  await Restaurant.collection.updateOne(
    { _id: rid },
    { $set: { payoutAccount: { status: 'verified', accountHolderName: 'Spice Kitchen', accountNumberLast4: '4321', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' } } }
  );

  const future = new Date(Date.now() + 3 * 86_400_000);
  const settlementId = oid();
  await RestaurantLedgerEntry.collection.insertMany([
    // Paid in an old weekly statement (₹100) — no longer owed.
    row({ amountPaise: 10000, settlementId, createdAt: ist('2026-11-10T10:00:00'), eligibleAt: ist('2026-11-10T10:00:00'), clearsAt: ist('2026-11-10T10:00:00') }),
    // 20 Nov: two orders ₹500 + ₹300, a counter fee −₹20.
    row({ amountPaise: 50000 }),
    row({ amountPaise: 30000, type: 'dine_in_earning', createdAt: ist('2026-11-20T21:00:00') }),
    row({ amountPaise: 2000, type: 'counter_platform_fee', direction: 'debit', createdAt: ist('2026-11-20T22:00:00') }),
    // 21 Nov: an admin adjustment +₹50.
    row({ amountPaise: 5000, type: 'adjustment', createdAt: ist('2026-11-21T09:00:00') }),
    // Earned recently but Razorpay hasn't settled it yet: ₹200 still clearing.
    row({ amountPaise: 20000, createdAt: new Date(), eligibleAt: future, clearsAt: future }),
  ]);
  await RestaurantSettlement.collection.insertOne({
    _id: settlementId,
    restaurantId: rid,
    status: 'paid',
    periodStart: ist('2026-11-09T00:00:00'),
    periodEnd: ist('2026-11-15T23:59:59'),
    totals: { netPayable: 10000 },
    payout: { paidAt: ist('2026-11-17T12:00:00'), utr: 'OLDUTR' },
  });
});

const url = (p) => `/api/admin/finance/restaurant-payouts${p}`;
const pay = (body) => srv.request('POST', url(`/balances/${rid}/pay`), { headers: admin, body });
// Owed: 500 + 300 − 20 + 50 + 200 (clearing) = ₹1,030; cleared ₹830.
const OWED = 103000;

test('balance: ledger minus old weekly payments, with the still-clearing part', async () => {
  const res = await srv.get(url(`/balances/${rid}`), admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const b = res.body.data;
  assert.equal(b.balancePaise, OWED);
  assert.equal(b.clearingPaise, 20000);
  assert.equal(b.clearedPaise, 83000);
  assert.equal(b.account.accountNumberLast4, '4321');

  const list = await srv.get(url('/balances?due=1'), admin);
  assert.equal(list.body.data.rows.length, 1);
  assert.equal(list.body.data.totals.balancePaise, OWED);
  assert.equal(list.body.data.mode, 'anytime');
});

test('pay part, then the rest in full — including money still clearing', async () => {
  let res = await pay({ amountPaise: 40000, mode: 'neft', reference: 'UTR0001', expectedBalancePaise: OWED, note: 'first half' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.payment.kind, 'partial');
  assert.equal(res.body.data.payment.paymentNumber, 'RP-000001');
  assert.equal(res.body.data.balance.balancePaise, OWED - 40000);

  // The ledger carries it as a payout debit — the one place the balance comes from.
  const entry = await RestaurantLedgerEntry.findOne({ type: 'payout' }).lean();
  assert.equal(entry.amountPaise, 40000);
  assert.equal(entry.direction, 'debit');

  // Showing the old balance is refused: someone may have paid meanwhile.
  res = await pay({ full: true, mode: 'neft', reference: 'UTR0002', expectedBalancePaise: OWED });
  assert.equal(res.status, 409);
  assert.equal(res.body.code ?? res.body.error?.code, 'BALANCE_CHANGED');

  res = await pay({ full: true, mode: 'imps', reference: 'UTR0002', expectedBalancePaise: OWED - 40000 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.payment.kind, 'full');
  assert.equal(res.body.data.payment.amountPaise, OWED - 40000);
  assert.equal(res.body.data.balance.balancePaise, 0);

  res = await pay({ full: true, mode: 'neft', reference: 'UTR0003', expectedBalancePaise: 0 });
  assert.equal(res.status, 409, 'nothing left to pay');
});

test('limits: no more than owed, a reference, a past date, verified account for bank transfers', async () => {
  let res = await pay({ amountPaise: OWED + 1, mode: 'neft', reference: 'UTR1', expectedBalancePaise: OWED });
  assert.equal(res.status, 400);
  res = await pay({ amountPaise: 1000, mode: 'neft', reference: '', expectedBalancePaise: OWED });
  assert.equal(res.status, 400);
  res = await pay({ amountPaise: 1000, mode: 'neft', reference: 'UTR1', paidOn: '2999-01-01', expectedBalancePaise: OWED });
  assert.equal(res.status, 400);

  await Restaurant.collection.updateOne({ _id: rid }, { $set: { 'payoutAccount.status': 'pending' } });
  res = await pay({ amountPaise: 1000, mode: 'neft', reference: 'UTR1', expectedBalancePaise: OWED });
  assert.equal(res.status, 409, 'bank transfer needs a verified account');
  res = await pay({ amountPaise: 1000, mode: 'upi', reference: 'UPI-REF-1', paidOn: '2026-11-21', expectedBalancePaise: OWED });
  assert.equal(res.status, 201, 'UPI is the admin’s call');
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(res.body.data.payment.paidAt)), '2026-11-21');
});

test('two payments at once: only one goes through', async () => {
  const [a, b] = await Promise.all([
    pay({ full: true, mode: 'neft', reference: 'UTR-A', expectedBalancePaise: OWED }),
    pay({ full: true, mode: 'neft', reference: 'UTR-B', expectedBalancePaise: OWED }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal(await RestaurantPayment.countDocuments(), 1);
});

test('daily report: each day, opening and closing balance, and a total that matches the balance', async () => {
  await pay({ amountPaise: 30000, mode: 'neft', reference: 'UTR-21', paidOn: '2026-11-21', expectedBalancePaise: OWED });

  const res = await srv.get(url(`/daily?restaurantId=${rid}&from=2026-11-19&to=2026-11-21`), admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.data;
  assert.equal(r.openingBalancePaise, 0, 'the old ₹100 was paid by its weekly statement');
  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
  assert.deepEqual(Object.keys(byDate).sort(), ['2026-11-19', '2026-11-20', '2026-11-21']);
  assert.equal(byDate['2026-11-20'].entries, 2);
  assert.equal(byDate['2026-11-20'].earningsPaise, 80000);
  assert.equal(byDate['2026-11-20'].deductionsPaise, 2000);
  assert.equal(byDate['2026-11-20'].netEarnedPaise, 78000);
  assert.equal(byDate['2026-11-20'].closingBalancePaise, 78000);
  assert.equal(byDate['2026-11-21'].adjustmentsPaise, 5000);
  assert.equal(byDate['2026-11-21'].paidPaise, 30000);
  assert.equal(byDate['2026-11-21'].closingBalancePaise, 78000 + 5000 - 30000);

  // Through today, the last closing balance is exactly what is owed now.
  const now = await srv.get(url(`/daily?restaurantId=${rid}&from=2026-11-01&to=${istToday()}`), admin);
  const bal = await srv.get(url(`/balances/${rid}`), admin);
  assert.equal(now.body.data.closingBalancePaise, bal.body.data.balancePaise);
  // The old weekly statement shows as paid on its day.
  assert.equal(now.body.data.days.find((d) => d.date === '2026-11-17').paidPaise, 10000);

  // All restaurants together, with a per-restaurant summary.
  const all = await srv.get(url('/daily?from=2026-11-19&to=2026-11-21'), admin);
  assert.equal(all.body.data.restaurants[0].name, seed.restaurant.name);
  assert.equal(all.body.data.restaurants[0].paidPaise, 30000);

  assert.equal((await srv.get(url('/daily?from=2026-11-21&to=2026-11-01'), admin)).status, 400);
  assert.equal((await srv.get(url('/daily?from=2024-01-01&to=2026-11-01'), admin)).status, 400);
});

test('Excel export of the report', async () => {
  await pay({ amountPaise: 30000, mode: 'neft', reference: 'UTR-21', paidOn: '2026-11-21', expectedBalancePaise: OWED, note: 'internal' });
  const res = await fetch(`${srv.base}${url(`/daily/export.xlsx?restaurantId=${rid}&from=2026-11-20&to=2026-11-21`)}`, { headers: admin });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /payouts-.*-2026-11-20-to-2026-11-21\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Daily', 'Payments']);
  const daily = wb.getWorksheet('Daily');
  assert.equal(daily.getRow(2).getCell(1).value, '20-11-2026');
  assert.equal(daily.getRow(3).getCell(7).value, 300);
  const pays = wb.getWorksheet('Payments');
  assert.deepEqual(pays.getRow(2).values.slice(2, 7), ['RP-000001', 300, 'Part', 'NEFT', 'UTR-21']);
  assert.equal(pays.getRow(2).getCell(8).value, 'internal', 'the admin file keeps the note');
});

test('the restaurant sees its balance, the payments it got (no internal note) and its daily report', async () => {
  await pay({ amountPaise: 30000, mode: 'neft', reference: 'UTR-21', paidOn: '2026-11-21', expectedBalancePaise: OWED, note: 'internal only' });
  const base = `/api/owner/${rid}/payments`;

  const bal = await srv.get(`${base}/balance`, owner);
  assert.equal(bal.status, 200, JSON.stringify(bal.body));
  assert.equal(bal.body.data.balancePaise, OWED - 30000);
  assert.equal(bal.body.data.clearingPaise, 20000);
  assert.equal(bal.body.data.lastPayment.reference, 'UTR-21');

  const got = await srv.get(`${base}/received`, owner);
  assert.equal(got.body.data.payments.length, 1);
  assert.equal(got.body.data.payments[0].note, undefined);
  assert.equal(got.body.data.payments[0].beneficiary.accountNumberLast4, '4321');

  const daily = await srv.get(`${base}/daily?from=2026-11-20&to=2026-11-21`, owner);
  assert.equal(daily.body.data.days.length, 2);
  assert.equal(daily.body.data.restaurants, null);

  const xlsx = await fetch(`${srv.base}${base}/daily/export.xlsx?from=2026-11-20&to=2026-11-21`, { headers: owner });
  assert.equal(xlsx.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xlsx.arrayBuffer()));
  const headers = wb.getWorksheet('Payments').getRow(1).values.slice(1);
  assert.ok(!headers.includes('Note'), 'no internal note in the restaurant’s file');

  // Only admins pay.
  const tryPay = await srv.request('POST', url(`/balances/${rid}/pay`), { headers: owner, body: { full: true, mode: 'neft', reference: 'X123', expectedBalancePaise: 1 } });
  assert.equal(tryPay.status, 403);
});

test('weekly payout actions are refused in anytime mode', async () => {
  const draft = await RestaurantSettlement.collection.insertOne({ restaurantId: rid, status: 'approved', periodStart: new Date(), periodEnd: new Date(), totals: { netPayable: 5000 }, payout: {} });
  const id = draft.insertedId;
  const fin = (p) => `/api/admin/finance${p}`;
  for (const [method, path] of [
    ['POST', '/settlements/generate'],
    ['PATCH', `/settlements/${id}/approve`],
    ['PATCH', `/payouts/${id}/release`],
    ['PATCH', `/payouts/${id}/schedule`],
    ['PATCH', `/settlements/${id}/mark-paid`],
    ['POST', '/payout-batches'],
    ['POST', `/weekly-report/restaurants/${id}/mark-paid`],
  ]) {
    const res = await srv.request(method, fin(path), { headers: admin, body: {} });
    assert.equal(res.status, 409, `${method} ${path}`);
    assert.equal(res.body.code ?? res.body.error?.code, 'WEEKLY_PAYOUTS_RETIRED');
  }
  // The unpaid weekly statement's money is simply still owed — payable from the balance.
  const bal = await srv.get(url(`/balances/${rid}`), admin);
  assert.equal(bal.body.data.balancePaise, OWED);
});
