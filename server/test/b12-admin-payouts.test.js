// B12 — the super admin's payout screens (Figma S1–S5, D1–D6): the weekly batch (KPIs with
// counts, food incl. GST / deductions / net, both status axes, next action, tab counts), payout
// history (filters, KPIs, transfer date, bank reference, CSV), and payout detail (calculation
// lines that add up to the net, records, progress steps, linked tickets, what the owner sees,
// the staff-only hold note). In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const { computeRestaurantSettlementLine } = await import('../services/settlementMath.service.js');
const settlementService = await import('../services/settlement.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: SupportTicket } = await import('../models/SupportTicket.js');
const { generateTokens } = await import('../services/auth.service.js');

const WEEK = new Date('2026-10-07T06:00:00Z'); // week of Mon 5 Oct 2026 (IST)
const WEEK_START = new Date('2026-10-04T18:30:00.000Z');
const CLOCK = new Date('2026-10-20T06:00:00Z');

let mongo;
let srv;
let owner;
let admin;
let gst;
let nonGst;
let settings;

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

const account = (last4) => ({
  accountHolderName: 'Holder',
  accountNumberEncrypted: encryptField(`12345678${last4}`),
  accountNumberLast4: last4,
  ifsc: 'HDFC0001234',
  accountType: 'current',
  status: 'verified',
  submittedAt: new Date('2026-09-01T00:00:00Z'),
  verifiedAt: new Date('2026-09-02T00:00:00Z'),
});

// A delivered online order and its ledger row, in the week of 5 Oct (already cleared).
const earning = async (restaurant, { free = false } = {}) => {
  const charges = computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant: { gstRegistered: true, delivery: free ? { freeThreshold: 100 } : {} },
    distanceKm: 1,
    settings,
  });
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    status: 'delivered',
    deliveredAt: WEEK,
  });
  const line = computeRestaurantSettlementLine({ charges, paymentChannel: 'online', settings });
  return RestaurantLedgerEntry.create({
    restaurantId: restaurant._id,
    type: 'order_earning',
    direction: 'credit',
    amountPaise: line.restaurantNet,
    orderId: order._id,
    breakdown: line,
    eligibleAt: WEEK,
    clearsAt: WEEK,
  });
};

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  settlementService.__setSettlementClockForTests(() => CLOCK);
  settings = await getActiveSettings();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  gst = await Restaurant.create({
    ownerId: owner._id,
    name: 'Annapurna Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    gstRegistered: true,
    payoutAccount: account('4417'),
  });
  nonGst = await Restaurant.create({
    ownerId: owner._id,
    name: 'Biryani Bazaar',
    location: { type: 'Point', coordinates: [77.6, 12.98] },
    approvalStatus: 'active',
    gstRegistered: false,
    payoutAccount: account('9012'),
  });
  await earning(gst); // case 1: 30250
  await earning(gst, { free: true }); // case 2: 27355
  await RestaurantLedgerEntry.create({
    restaurantId: gst._id,
    type: 'counter_platform_fee',
    direction: 'debit',
    amountPaise: 1242,
    breakdown: { paymentChannel: 'counter' },
    eligibleAt: WEEK,
    clearsAt: WEEK,
  });
  await earning(nonGst);
  await settlementService.generateWeeklySettlements(WEEK);
});

const headers = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });
const ok = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  return res.body.data;
};
const settlementOf = (r) => RestaurantSettlement.findOne({ restaurantId: r._id, periodStart: WEEK_START }).lean();
// What the rows say — the expected figures are taken from them, not from the PDF's prices.
const rowsOf = (r) => RestaurantLedgerEntry.find({ restaurantId: r._id }).lean();
const netOf = (rows) => rows.reduce((n, e) => n + (e.direction === 'credit' ? e.amountPaise : -e.amountPaise), 0);
const foodOf = (rows) =>
  rows
    .filter((e) => e.type === 'order_earning')
    .reduce((n, e) => n + e.breakdown.customerPaid - e.breakdown.yuloMoney.platformFee - e.breakdown.yuloMoney.deliveryCharge - e.breakdown.tip, 0);

test('weekly batch: rows with food incl. GST, deductions, both axes, next action; KPIs with counts; tab counts', async () => {
  const sNon = await settlementOf(nonGst);
  await settlementService.scheduleSettlement(sNon._id, { scheduledFor: '2026-10-26' }, admin._id);
  const sGst = await settlementOf(gst);
  await settlementService.holdSettlement(sGst._id, admin._id, { reason: 'dispute_review', note: 'staff only' });
  await SupportTicket.create({
    raisedByType: 'owner',
    raisedBy: owner._id,
    restaurantId: gst._id,
    subject: 'Payout not received',
    description: 'Where is it?',
    kind: 'payment',
    issueType: 'payout_not_received',
    status: 'open',
  });
  await Restaurant.updateOne({ _id: nonGst._id }, { $set: { 'payoutAccount.pendingChange': { status: 'in_review', requestedAt: new Date() } } });

  const data = ok(await srv.get(`/api/admin/finance/payouts/weekly?weekStart=${WEEK.toISOString()}`, headers()));
  assert.equal(new Date(data.periodStart).toISOString(), WEEK_START.toISOString());
  assert.equal(data.rows.length, 2);
  const byName = Object.fromEntries(data.rows.map((r) => [r.restaurant.name, r]));

  const a = byName['Annapurna Kitchen'];
  const gstRows = await rowsOf(gst);
  assert.equal(a.restaurant.gstRegistered, true);
  assert.equal(a.foodInclGstPaise, foodOf(gstRows), 'food + its GST (+ round-off) of both orders');
  assert.ok(a.foodInclGstPaise > 60000);
  assert.equal(a.netPayablePaise, netOf(gstRows));
  assert.equal(a.deductionsPaise, a.foodInclGstPaise - a.netPayablePaise);
  assert.equal(a.eligibility, 'on_hold');
  assert.equal(a.transfer.status, 'not_scheduled');
  assert.equal(a.holdLabel, 'Dispute review');
  assert.equal(a.nextAction, 'review_hold');
  assert.equal(a.counts.orders, 2);

  const b = byName['Biryani Bazaar'];
  assert.equal(b.restaurant.gstRegistered, false);
  assert.equal(b.eligibility, 'eligible');
  assert.equal(b.transfer.status, 'scheduled');
  assert.equal(b.nextAction, 'review');

  const nonNet = netOf(await rowsOf(nonGst));
  assert.deepEqual(data.kpis.batchTotal, { amountPaise: a.netPayablePaise + nonNet, restaurants: 2, orders: 3 });
  assert.deepEqual(data.kpis.readyToRelease, { amountPaise: nonNet, restaurants: 1 });
  assert.equal(data.kpis.onHold.restaurants, 1);
  assert.deepEqual(data.kpis.onHold.reasons, ['Dispute review']);
  assert.equal(data.kpis.awaitingClearance.orders, 0);
  assert.deepEqual(data.tabCounts, { clearanceQueue: 0, bankRequests: 1, paymentIssues: 1 });
  assert.doesNotMatch(JSON.stringify(data), /staff only/);
});

test('payout detail: lines add up to the net, records, progress, linked ticket, owner view, staff-only note for admin', async () => {
  const s = await settlementOf(gst);
  await SupportTicket.create({
    raisedByType: 'owner',
    raisedBy: owner._id,
    restaurantId: gst._id,
    subject: 'Wrong deduction',
    description: 'Check the dine-in dues',
    kind: 'payment',
    issueType: 'wrong_deduction',
    ticketNumber: 'YP-20261012-001',
    settlementId: s._id,
  });
  await settlementService.scheduleSettlement(s._id, { scheduledFor: '2026-10-21' }, admin._id);
  await settlementService.releaseSettlement(s._id, admin._id);

  const d = ok(await srv.get(`/api/admin/finance/payouts/${s._id}`, headers()));
  assert.equal(d.restaurant.name, 'Annapurna Kitchen');
  assert.equal(d.destination.accountNumberLast4, '4417');
  assert.equal(d.destination.verified, true);
  assert.equal(d.transfer.status, 'processing');
  assert.equal(d.nextAction, 'record_result');

  const rows = await rowsOf(gst);
  const earnings = rows.filter((e) => e.type === 'order_earning');
  const lines = Object.fromEntries(d.calculation.lines.map((l) => [l.key, l]));
  assert.equal(lines.food.label, 'Food incl. GST');
  assert.equal(lines.food.amountPaise, foodOf(rows));
  assert.equal(lines.freeDelivery.amountPaise, -earnings.reduce((n, e) => n + e.breakdown.restaurantBorneDelivery, 0));
  assert.ok(lines.freeDelivery.amountPaise < 0, 'case 2: the restaurant bears the delivery');
  assert.equal(lines.settlementFees.amountPaise, -earnings.reduce((n, e) => n + e.breakdown.settlementCharge.total, 0));
  assert.equal(lines.dineInDues.amountPaise, -1242);
  assert.equal(lines.refundAdjustment.amountPaise, 0);
  assert.equal(lines.other, undefined, 'the named lines explain the whole net');
  assert.equal(d.calculation.lines.reduce((n, l) => n + l.amountPaise, 0), d.calculation.netPayoutPaise);
  assert.equal(d.calculation.netPayoutPaise, netOf(rows));

  assert.deepEqual(d.counts, { foodOrders: 2, dineInBills: 0, dineInAdjustments: 1, refunds: 0 });
  assert.equal(d.records.length, 3);
  assert.deepEqual(new Set(d.records.map((r) => r.type)), new Set(['Delivery order', 'Dine-in dues']));
  assert.ok(d.records.every((r) => r.status === 'eligible'));
  assert.deepEqual(d.progress.map((p) => [p.key, p.done]), [['eligible', true], ['scheduled', true], ['released', true], ['paid', false]]);
  assert.equal(d.linkedTickets.length, 1);
  assert.equal(d.linkedTickets[0].ticketNumber, 'YP-20261012-001');
  assert.equal(d.ownerView.status, 'Processing');
  assert.doesNotMatch(JSON.stringify(d), /gateway|yuloSettlementMargin|riderPay/, 'no Razorpay fee / margin on payout detail');

  // A non-GST restaurant's food line; the staff-only note reaches the admin.
  const n = await settlementOf(nonGst);
  await settlementService.holdSettlement(n._id, admin._id, { reason: 'compliance_review', note: 'KYC pending' });
  const dn = ok(await srv.get(`/api/admin/finance/payouts/${n._id}`, headers()));
  assert.equal(dn.calculation.lines.find((l) => l.key === 'food').label, 'Food');
  assert.deepEqual(
    { reason: dn.settlement.hold.reason, label: dn.settlement.hold.label, note: dn.settlement.hold.internalNote },
    { reason: 'compliance_review', label: 'Compliance review', note: 'KYC pending' }
  );
});

test('payout history: filters, KPIs over the filter, transfer date and bank reference, CSV', async () => {
  const sGst = await settlementOf(gst);
  const sNon = await settlementOf(nonGst);
  await settlementService.scheduleSettlement(sGst._id, { scheduledFor: '2026-10-21' }, admin._id);
  await settlementService.releaseSettlement(sGst._id, admin._id);
  await settlementService.recordPayoutPaid(sGst._id, { bankReference: 'UTR-PAID-1' }, admin._id);
  await settlementService.scheduleSettlement(sNon._id, { scheduledFor: '2026-10-28' }, admin._id);

  const all = ok(await srv.get('/api/admin/finance/payouts/history', headers()));
  assert.equal(all.total, 2);
  assert.deepEqual(all.kpis.paid, { amountPaise: netOf(await rowsOf(gst)), count: 1 });
  assert.equal(all.kpis.scheduled.count, 1);
  assert.equal(new Date(all.kpis.scheduled.nextDate).toISOString(), '2026-10-27T18:30:00.000Z');
  assert.deepEqual(all.kpis.notYetScheduled, { amountPaise: 0, count: 0 });
  const paidRow = all.rows.find((r) => r.transfer.status === 'paid');
  assert.equal(paidRow.bankReference, 'UTR-PAID-1');
  assert.ok(paidRow.transferDate);
  const schedRow = all.rows.find((r) => r.transfer.status === 'scheduled');
  assert.equal(new Date(schedRow.transferDate).toISOString(), '2026-10-27T18:30:00.000Z');
  assert.equal(schedRow.bankReference, null, '"Added when paid"');

  const onlyPaid = ok(await srv.get('/api/admin/finance/payouts/history?transferStatus=paid', headers()));
  assert.equal(onlyPaid.total, 1);
  assert.equal(onlyPaid.kpis.scheduled.count, 1, 'KPIs ignore the status filter');
  const oneRestaurant = ok(await srv.get(`/api/admin/finance/payouts/history?restaurantId=${nonGst._id}`, headers()));
  assert.equal(oneRestaurant.total, 1);
  assert.equal((await srv.get('/api/admin/finance/payouts/history?transferStatus=bogus', headers())).status, 400);

  const csv = await srv.get('/api/admin/finance/payouts/history/export', headers());
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('cache-control'), /no-store/);
  const lines = csv.body.trim().split('\n');
  assert.match(lines[0], /^Restaurant,Statement start,Statement end,Net payout \(₹\),Eligibility,Bank transfer,Transfer date,Bank reference$/);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes('UTR-PAID-1') && l.includes('Paid') && l.includes('2026-10-05')));
});

test('options: reason codes and the default release date; admin only', async () => {
  const o = ok(await srv.get('/api/admin/finance/payouts/options', headers()));
  assert.ok(o.holdReasons.dispute_review);
  assert.ok(o.failureReasons.bank_rejected_credit);
  assert.equal(o.payoutDayOfWeek, 'wednesday');
  assert.equal(new Date(o.defaultReleaseDate).toISOString(), '2026-10-20T18:30:00.000Z', 'Wed 21 Oct IST');

  const asOwner = await srv.get('/api/admin/finance/payouts/weekly', {
    authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}`,
  });
  assert.equal(asOwner.status, 403);
});
