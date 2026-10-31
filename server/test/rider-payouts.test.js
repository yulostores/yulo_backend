// B10 — rider earnings and payouts on the frozen per-delivery breakdown: payouts sum base +
// distance + tip, tips reach the rider, paid payouts are frozen, only ended weekly payouts are
// paid, weekly and monthly rows don't collide or double count, per-delivery lines in the
// partner earnings response, and the partner config endpoint. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, createVersion } = await import('../services/financeSettings.service.js');
const payoutService = await import('../services/payout.service.js');
const { weekBounds } = await import('../utils/week.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Payout } = await import('../models/Payout.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { generateTokens, generatePartnerTokens } = await import('../services/auth.service.js');

const IST = { weekStartsOn: 'monday', timezone: 'Asia/Kolkata' };
const DAY = 24 * 60 * 60 * 1000;

let mongo;
let srv;
let admin;
let partner;
let restaurant;

before(async () => {
  mongo = await startMemoryMongo();
  await Payout.init();
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  await Payout.syncIndexes();
  __resetFinanceSettingsCache();
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [77.59, 12.97] } });
  partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi' });
});

const delivered = (deliveredAt, { basePay = 20, distancePay = 0, tip = 0, distanceKm = 1.5 } = {}) =>
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
      earningsBreakdown: { basePay, distancePay, tip, distanceKm, computedAt: new Date() },
    },
  });

const adminHeaders = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });
const partnerHeaders = () => ({ authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` });
const lastWeekMidpoint = () => new Date(weekBounds(new Date(), IST).start.getTime() - 3 * DAY);

test('weekly payout = sum of the frozen breakdowns, tips included and paid to the rider', async () => {
  const at = lastWeekMidpoint();
  await delivered(at, { basePay: 20, distancePay: 7, tip: 30, distanceKm: 3.4 });
  await delivered(at, { basePay: 20 });

  const payout = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', at);
  assert.equal(payout.deliveriesCount, 2);
  assert.equal(payout.basePay, 40);
  assert.equal(payout.distancePay, 7);
  assert.equal(payout.tips, 30);
  assert.equal(payout.grossEarnings, 47);
  assert.equal(payout.netPayable, 77, 'gross + tips');
});

test('a paid payout is never recomputed or adjusted; the current week and monthly rows cannot be paid', async () => {
  const at = lastWeekMidpoint();
  await delivered(at, { basePay: 20, tip: 10 });

  const list = await srv.get(`/api/admin/delivery-partners/${partner._id}/payouts?period=weekly`, adminHeaders());
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const [current, previous] = list.body.data.rows;
  assert.equal(previous.payable, true, 'last week has ended');
  assert.equal(current.payable, false, 'this week has not');

  const pay = await srv.request('POST', '/api/admin/delivery-partners/payouts/mark-paid', {
    headers: adminHeaders(),
    body: { payoutIds: [previous._id, current._id] },
  });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.data.modifiedCount, 1);
  assert.match(pay.body.data.skipped[0].reason, /not ended/);

  // A late-recorded delivery in the paid week must not change the paid row.
  await delivered(at, { basePay: 20, tip: 50 });
  await srv.get(`/api/admin/delivery-partners/${partner._id}/payouts?period=weekly`, adminHeaders());
  const frozen = await Payout.findById(previous._id).lean();
  assert.equal(frozen.status, 'paid');
  assert.equal(frozen.netPayable, 30);
  assert.equal(frozen.deliveriesCount, 1);

  await assert.rejects(
    payoutService.adjustPayout(previous._id, { incentives: 100, adjustedBy: admin._id }),
    (e) => e.code === 'PAYOUT_FROZEN'
  );

  const monthly = await payoutService.ensurePayoutForPeriod(partner._id, 'monthly', at);
  const monthlyPay = await payoutService.markPayoutsPaid([monthly._id]);
  assert.equal(monthlyPay.modifiedCount, 0);
  assert.match(monthlyPay.skipped[0].reason, /statements/);
});

test('deductions can take a rider\'s week to zero but never below it', async () => {
  const at = lastWeekMidpoint();
  await delivered(at, { basePay: 20, tip: 10 });
  await delivered(at, { basePay: 20 });
  const payout = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', at);
  assert.equal(payout.netPayable, 50);

  const tooMuch = await srv.request('PATCH', `/api/admin/delivery-partners/${partner._id}/payouts/${payout._id}`, {
    headers: adminHeaders(),
    body: { incentives: 5, deductions: 500 },
  });
  assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.body));
  assert.equal(tooMuch.body.code, 'DEDUCTION_EXCEEDS_EARNINGS');
  assert.match(tooMuch.body.message, /₹55\.00/, 'names the most that can be deducted');
  assert.equal((await Payout.findById(payout._id).lean()).netPayable, 50, 'nothing saved');

  const toZero = await payoutService.adjustPayout(payout._id, { incentives: 5, deductions: 55, adjustedBy: admin._id });
  assert.equal(toZero.netPayable, 0);
});

test('weekly and monthly rows starting the same day do not collide; platform total counts weekly only', async () => {
  // Monday 1 June 2026 (IST) starts both a week and a month.
  const at = new Date('2026-06-02T06:00:00Z');
  await delivered(at, { basePay: 20, tip: 5 });

  const weekly = await payoutService.ensurePayoutForPeriod(partner._id, 'weekly', at);
  const monthly = await payoutService.ensurePayoutForPeriod(partner._id, 'monthly', at);
  assert.equal(weekly.periodStart.toISOString(), monthly.periodStart.toISOString(), 'same start date');
  assert.notEqual(String(weekly._id), String(monthly._id));
  assert.equal(await Payout.countDocuments({ partnerId: partner._id }), 2);

  const total = await payoutService.getPlatformPayoutTotal({ from: monthly.periodStart, to: monthly.periodEnd });
  assert.equal(total, 25, 'the month is not counted on top of its week');
});

test('partner earnings: totals with tips, plus a line per delivery', async () => {
  const now = new Date();
  await delivered(now, { basePay: 20, distancePay: 7, tip: 30, distanceKm: 3.4 });
  await delivered(new Date(now.getTime() - 60_000), { basePay: 20 });

  const res = await srv.get('/api/partner/earnings?period=weekly', partnerHeaders());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data;
  assert.equal(data.orders, 2);
  assert.equal(data.tips, 30);
  assert.equal(data.totalEarned, 77);
  assert.equal(data.deliveries.length, 2);
  const first = data.deliveries[0];
  assert.deepEqual(
    { basePay: first.basePay, distancePay: first.distancePay, tip: first.tip, total: first.total, km: first.distanceKm },
    { basePay: 20, distancePay: 7, tip: 30, total: 57, km: 3.4 }
  );
  assert.equal(first.restaurantName, 'Spice Route');
});

test('partner config exposes the COD switch, behind partner auth', async () => {
  const anon = await srv.get('/api/partner/config');
  assert.equal(anon.status, 401);

  const off = await srv.get('/api/partner/config', partnerHeaders());
  assert.equal(off.status, 200);
  assert.equal(off.body.data.config.codEnabled, false);

  await createVersion({ patch: { codEnabled: true } }, admin._id);
  const on = await srv.get('/api/partner/config', partnerHeaders());
  assert.equal(on.body.data.config.codEnabled, true);
});

test('delivery summary: every part present (0 for a legacy breakdown) and the server\'s total', async () => {
  const order = await delivered(new Date(), { basePay: 20, distancePay: 6.5, tip: 20, distanceKm: 3.3 });
  const res = await srv.get(`/api/partner/orders/${order._id}/summary`, partnerHeaders());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.payout, { basePay: 20, distancePay: 6.5, surge: 0, tip: 20, penalty: 0, total: 46.5 });
  assert.equal(res.body.data.totalKm, 3.3);
});
