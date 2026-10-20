// B12 — clearing: online money is settlement-eligible only once Razorpay's T+2 working-day
// settlement to Yulo has passed (and the order is delivered / the bill paid). The working-day
// calendar (IST, Sat/Sun excluded), ledger rows' clearsAt/eligibleAt, a Sunday payment landing in
// next week's statement, counter rows not waiting, the clearance queue, and the clearsAt
// backfill. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { addWorkingDays, clearanceTime } = await import('../utils/workingDays.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const ledgerService = await import('../services/ledger.service.js');
const settlementService = await import('../services/settlement.service.js');
const { clearanceQueue } = await import('../services/payoutView.service.js');
const { backfillClearsAt } = await import('../scripts/backfillClearsAt.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { generateTokens } = await import('../services/auth.service.js');

// IST wall clock → UTC instant.
const ist = (iso) => new Date(new Date(`${iso}Z`).getTime() - 5.5 * 60 * 60 * 1000);
const quiet = () => {};

let mongo;
let srv;
let admin;
let restaurant;
let charges;

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
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Annapurna Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    gstRegistered: true,
  });
  charges = computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant: { gstRegistered: true, delivery: {} },
    distanceKm: 1,
    settings: await getActiveSettings(),
  });
});

const paidOrder = (paidAt, fields = {}) =>
  Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    grandTotal: charges.grandTotal / 100,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    paidAt,
    status: 'confirmed',
    ...fields,
  });

test('the working-day calendar: T+2 in IST, weekends skipped', () => {
  const cases = [
    ['2026-10-07T10:00:00', '2026-10-09T00:00:00'], // Wed → Fri
    ['2026-10-08T23:30:00', '2026-10-12T00:00:00'], // Thu night → Mon
    ['2026-10-09T09:00:00', '2026-10-13T00:00:00'], // Fri → Tue
    ['2026-10-10T12:00:00', '2026-10-13T00:00:00'], // Sat → Tue
    ['2026-10-11T23:59:00', '2026-10-13T00:00:00'], // Sun → Tue
    ['2026-10-04T23:00:00', '2026-10-06T00:00:00'], // Sun 23:00 IST is already Sunday the 4th in IST → Tue 6th
  ];
  for (const [captured, cleared] of cases) {
    assert.equal(clearanceTime(ist(captured)).toISOString(), ist(cleared).toISOString(), captured);
  }
  // 18:45 UTC on Sunday 4 Oct is 00:15 IST Monday 5 Oct → clears Wed 7th.
  assert.equal(addWorkingDays(new Date('2026-10-04T18:45:00Z')).toISOString(), ist('2026-10-07T00:00:00').toISOString());
});

test('an online earning is eligible at the later of delivery and clearance; counter money does not wait', async () => {
  // Paid Friday, delivered Friday → eligible Tuesday 00:00 IST.
  const friday = await paidOrder(ist('2026-10-09T13:00:00'), { status: 'delivered', deliveredAt: ist('2026-10-09T13:40:00') });
  const e1 = await ledgerService.recordOrderEarning(friday, { eligibleAt: friday.deliveredAt });
  assert.equal(e1.clearsAt.toISOString(), ist('2026-10-13T00:00:00').toISOString());
  assert.equal(e1.eligibleAt.getTime(), e1.clearsAt.getTime());

  // Paid Monday, delivered Thursday (after its Wednesday clearance) → eligible at delivery.
  const slow = await paidOrder(ist('2026-10-05T10:00:00'), { status: 'delivered', deliveredAt: ist('2026-10-08T12:00:00') });
  const e2 = await ledgerService.recordOrderEarning(slow, { eligibleAt: slow.deliveredAt });
  assert.equal(e2.eligibleAt.toISOString(), ist('2026-10-08T12:00:00').toISOString());

  // A dine-in bill paid at the counter: the restaurant's debit counts at once.
  const bill = await Bill.create({
    restaurantId: restaurant._id,
    type: 'dine_in',
    subtotal: 300,
    grandTotal: 327,
    charges: computeCustomerCharges({ orderType: 'dine_in', foodSubtotalPaise: 30000, restaurant: { gstRegistered: true }, settings: await getActiveSettings() }),
    status: 'paid',
    paidAt: ist('2026-10-11T21:00:00'),
    paymentChannel: 'counter',
    paidBy: 'cash',
  });
  const e3 = await ledgerService.recordBillSettlement(bill);
  assert.equal(e3.eligibleAt.toISOString(), ist('2026-10-11T21:00:00').toISOString());
  assert.equal(e3.clearsAt.getTime(), e3.eligibleAt.getTime());
});

test("a Sunday payment joins next week's statement, not this one", async () => {
  settlementService.__setSettlementClockForTests(() => new Date('2026-10-25T00:00:00Z'));
  const sunday = await paidOrder(ist('2026-10-11T19:00:00'), { status: 'delivered', deliveredAt: ist('2026-10-11T19:30:00') });
  await ledgerService.recordOrderEarning(sunday, { eligibleAt: sunday.deliveredAt });

  const week1 = await settlementService.generateWeeklySettlements(ist('2026-10-07T12:00:00'));
  assert.equal(week1.settlements.length, 0, 'not cleared by the end of the week of 5 Oct');
  const week2 = await settlementService.generateWeeklySettlements(ist('2026-10-14T12:00:00'));
  assert.equal(week2.settlements.length, 1);
  assert.equal(week2.settlements[0].entryCount, 1);
  assert.equal(new Date(week2.settlements[0].clearedAt).toISOString(), ist('2026-10-13T00:00:00').toISOString());
  settlementService.__setSettlementClockForTests(null);
});

test('clearance queue: paid-but-undelivered orders and rows still clearing, one row each, with totals', async () => {
  const now = new Date();
  const undelivered = await paidOrder(now); // confirmed, not delivered yet
  const delivered = await paidOrder(now, { status: 'delivered', deliveredAt: now });
  await ledgerService.recordOrderEarning(delivered, { eligibleAt: now });
  const old = await paidOrder(new Date('2026-01-05T06:00:00Z'), { status: 'delivered', deliveredAt: new Date('2026-01-05T07:00:00Z') });
  await ledgerService.recordOrderEarning(old, { eligibleAt: old.deliveredAt }); // long cleared

  const q = await clearanceQueue({});
  assert.equal(q.totals.count, 2);
  assert.equal(q.totals.restaurants, 1);
  const byId = Object.fromEntries(q.rows.map((r) => [String(r.id), r]));
  assert.equal(byId[String(undelivered._id)].stage, 'awaiting_delivery');
  assert.equal(byId[String(undelivered._id)].clearsAt, null);
  assert.equal(byId[String(delivered._id)].stage, 'clearing');
  assert.ok(new Date(byId[String(delivered._id)].clearsAt) > now);
  assert.equal(byId[String(old._id)], undefined, 'cleared money is not in the queue');
  for (const r of q.rows) {
    assert.equal(r.eligibility, 'pending');
    assert.equal(r.statementId, null);
    assert.equal(r.customerPaidPaise, charges.grandTotal);
    assert.equal(typeof r.expectedPayoutPaise, 'number');
    assert.match(r.displayNo, /^#[0-9A-F]{6}$/);
  }
  assert.equal(q.totals.expectedPayoutPaise, q.rows.reduce((n, r) => n + r.expectedPayoutPaise, 0));

  const res = await srv.get('/api/admin/finance/payouts/clearance', {
    authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.totals.count, 2);
});

test('backfill: unsettled online rows move to their clearance; settled and counter rows keep their date', async () => {
  const order = await paidOrder(ist('2026-10-09T13:00:00'), { status: 'delivered', deliveredAt: ist('2026-10-09T13:40:00') });
  const legacy = (fields) =>
    RestaurantLedgerEntry.collection.insertOne({
      restaurantId: restaurant._id,
      direction: 'credit',
      amountPaise: 1000,
      breakdown: {},
      settlementId: null,
      note: '',
      createdAt: new Date(),
      ...fields,
    });
  const { insertedId: online } = await legacy({ type: 'order_earning', orderId: order._id, eligibleAt: ist('2026-10-09T13:40:00') });
  const { insertedId: settled } = await legacy({
    type: 'order_earning',
    orderId: (await paidOrder(ist('2026-10-09T13:00:00')))._id,
    eligibleAt: ist('2026-10-09T13:40:00'),
    settlementId: restaurant._id,
  });
  const { insertedId: fee } = await legacy({ type: 'refund_gateway_fee', direction: 'debit', eligibleAt: ist('2026-10-10T10:00:00') });

  const dry = await backfillClearsAt({ apply: false, log: quiet });
  assert.deepEqual(dry, { rows: 3, moved: 1, unchanged: 2 });
  assert.equal((await RestaurantLedgerEntry.findById(online).lean()).clearsAt ?? null, null, 'a dry run writes nothing');

  await backfillClearsAt({ apply: true, log: quiet });
  const moved = await RestaurantLedgerEntry.findById(online).lean();
  assert.equal(moved.eligibleAt.toISOString(), ist('2026-10-13T00:00:00').toISOString());
  assert.equal(moved.clearsAt.getTime(), moved.eligibleAt.getTime());
  const kept = await RestaurantLedgerEntry.findById(settled).lean();
  assert.equal(kept.eligibleAt.toISOString(), ist('2026-10-09T13:40:00').toISOString(), 'its statement stands');
  assert.equal(kept.clearsAt.getTime(), kept.eligibleAt.getTime());
  assert.equal((await RestaurantLedgerEntry.findById(fee).lean()).clearsAt.toISOString(), ist('2026-10-10T10:00:00').toISOString());

  assert.deepEqual(await backfillClearsAt({ apply: true, log: quiet }), { rows: 0, moved: 0, unchanged: 0 }, 'idempotent');
});
