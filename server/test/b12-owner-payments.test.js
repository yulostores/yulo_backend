// B12 task 6 — the restaurant portal's Payments & Payouts endpoints (Figma owner frames): the
// overview (next payout, still clearing, Yulo money, destination, recent orders), payout history,
// statement detail, order / bill payment detail and bank & payout settings — on a seeded week of
// the PDF's cases. Owner-safe: no response ever carries Razorpay's fee, Yulo's margin, rider pay,
// the staff-only hold note or admin ids. In-memory MongoDB.

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
const { default: Bill } = await import('../models/Bill.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { generateTokens } = await import('../services/auth.service.js');

const WEEK = new Date('2026-10-07T06:00:00Z'); // inside the IST week Mon 5 – Sun 11 Oct 2026
const CLOCK = new Date('2026-10-20T06:00:00Z'); // settlement clock: that week has ended
const DAY = 24 * 60 * 60 * 1000;
const FORBIDDEN = ['gateway', 'razorpayFee', 'razorpayTax', 'yuloSettlementMargin', 'riderPay', 'internalNote', 'holdNote', 'markedPaidBy', 'releasedBy', 'scheduledBy', 'approvedBy', 'heldBy', 'createdBy', 'financials'];

let mongo;
let srv;
let owner;
let otherOwner;
let admin;
let restaurant;
let other;
let settings;
const ids = {};

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
  accountHolderName: 'Annapurna Kitchen',
  accountNumberEncrypted: encryptField(`12345678${last4}`),
  accountNumberLast4: last4,
  ifsc: 'HDFC0001234',
  accountType: 'current',
  status: 'verified',
  submittedAt: new Date('2026-09-01T00:00:00Z'),
  verifiedAt: new Date('2026-09-02T00:00:00Z'),
});

// The PDF's delivery cases exactly: ₹30 delivery (₹25.42 + ₹4.58 GST) — no distance prices to
// ₹30 at ₹8/km + GST, so the frozen breakdown's delivery is set to the PDF's figures.
const deliveryCharges = ({ free = false } = {}) => {
  const c = computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant: { gstRegistered: true, delivery: free ? { freeThreshold: 100 } : {} },
    distanceKm: 1,
    settings,
  });
  const delivery = { ...c.delivery, base: 2542, gst: 458, total: 3000, customerPays: free ? 0 : 3000 };
  const grandTotal = free ? 32700 : 35700;
  return { ...c, delivery, roundOff: 0, grandTotal, lines: c.lines.map((l) => (l.key === 'grand_total' ? { ...l, amountPaise: grandTotal } : l)) };
};
const dineInCharges = () =>
  computeCustomerCharges({ orderType: 'dine_in', foodSubtotalPaise: 30000, restaurant: { gstRegistered: true }, settings });

const row = (fields) => RestaurantLedgerEntry.create({ restaurantId: restaurant._id, ...fields });

const deliveredOnline = async ({ free = false, at = WEEK, clearsAt = at } = {}) => {
  const charges = deliveryCharges({ free });
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    paymentAmountPaise: charges.grandTotal,
    razorpayFee: 1138,
    razorpayTax: 174,
    status: 'delivered',
    deliveredAt: at,
  });
  const line = computeRestaurantSettlementLine({ charges, paymentChannel: 'online', razorpayFeePaise: 1138, razorpayTaxPaise: 174, riderPayPaise: 2000, settings });
  await row({ type: 'order_earning', direction: 'credit', amountPaise: line.restaurantNet, orderId: order._id, breakdown: line, eligibleAt: clearsAt, clearsAt });
  return order;
};

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  settlementService.__setSettlementClockForTests(() => CLOCK);
  settings = await getActiveSettings();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'Other', email: 'x@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Annapurna Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    gstRegistered: true,
    payoutAccount: account('4417'),
  });
  other = await Restaurant.create({
    ownerId: otherOwner._id,
    name: 'Other Kitchen',
    location: { type: 'Point', coordinates: [77.6, 12.98] },
    approvalStatus: 'active',
    gstRegistered: true,
    payoutAccount: account('9012'),
  });

  // Case 1 (302.50) and case 2 (273.55), delivered online in the week.
  ids.case1 = (await deliveredOnline())._id;
  ids.case2 = (await deliveredOnline({ free: true }))._id;

  // Case 3: a dine-in bill paid online (303.55).
  const dc = dineInCharges();
  const onlineBill = await Bill.create({
    restaurantId: restaurant._id,
    type: 'dine_in',
    billNumber: 'B-0001',
    tableNumber: '4',
    subtotal: 300,
    grandTotal: dc.grandTotal / 100,
    charges: dc,
    status: 'paid',
    paidAt: WEEK,
    paidBy: 'online',
    paymentChannel: 'online',
    paymentAmountPaise: dc.grandTotal,
  });
  const billLine = computeRestaurantSettlementLine({ charges: dc, paymentChannel: 'online', settings });
  await row({ type: 'dine_in_earning', direction: 'credit', amountPaise: billLine.restaurantNet, billId: onlineBill._id, breakdown: billLine, eligibleAt: WEEK, clearsAt: WEEK });
  ids.onlineBill = onlineBill._id;

  // Case 4: a dine-in bill paid at the counter by UPI (−12.42).
  const counterBill = await Bill.create({
    restaurantId: restaurant._id,
    type: 'dine_in',
    billNumber: 'B-0002',
    tableNumber: '6',
    subtotal: 300,
    grandTotal: dc.grandTotal / 100,
    charges: dc,
    status: 'paid',
    paidAt: WEEK,
    paidBy: 'upi',
    paymentChannel: 'counter',
  });
  const counterLine = computeRestaurantSettlementLine({ charges: dc, paymentChannel: 'counter', settings });
  await row({ type: 'counter_platform_fee', direction: 'debit', amountPaise: -counterLine.restaurantNet, billId: counterBill._id, breakdown: counterLine, eligibleAt: WEEK, clearsAt: WEEK });
  ids.counterBill = counterBill._id;

  // A refunded order: the restaurant rejected it, Razorpay kept ₹11.38 (restaurant-borne).
  const refunded = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges: deliveryCharges(),
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'refunded',
    status: 'cancelled',
    refund: { status: 'processed', amountPaise: 35700, reason: 'Restaurant rejected', processedAt: WEEK },
  });
  await row({ type: 'refund_gateway_fee', direction: 'debit', amountPaise: 1138, orderId: refunded._id, breakdown: null, eligibleAt: WEEK, clearsAt: WEEK });
  ids.refunded = refunded._id;

  await settlementService.generateWeeklySettlements(WEEK);

  // Still clearing (not in any statement): one delivered order inside T+2, one not delivered yet.
  ids.clearing = (await deliveredOnline({ at: new Date(), clearsAt: new Date(Date.now() + 3 * DAY) }))._id;
  const undelivered = deliveryCharges();
  ids.undelivered = (
    await Order.create({
      restaurantId: restaurant._id,
      type: 'delivery',
      items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
      subtotal: 300,
      charges: undelivered,
      paymentMethod: 'online',
      paymentChannel: 'online',
      paymentStatus: 'paid',
      status: 'preparing',
    })
  )._id;
});

const ownerHeaders = (u = owner) => ({ authorization: `Bearer ${generateTokens(u._id, 'restaurant_owner').accessToken}` });
const get = async (path, u = owner) => {
  const res = await srv.get(`/api/owner/${u === owner ? restaurant._id : other._id}/payments${path}`, ownerHeaders(u));
  return res;
};
const ok = (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 500));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assertOwnerSafe(res.body);
  return res.body.data;
};
const assertOwnerSafe = (body) => {
  const walk = (v, path) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      assert.ok(!FORBIDDEN.includes(k), `forbidden field "${k}" at ${path}.${k}`);
      walk(child, `${path}.${k}`);
    }
  };
  walk(body, '$');
};
const statementOf = () => RestaurantSettlement.findOne({ restaurantId: restaurant._id }).lean();
const NET = 30250 + 27355 + 30355 - 1242 - 1138;

test('overview: next payout, still clearing, Yulo money (no counter fee), destination, recent orders', async () => {
  const s = await statementOf();
  assert.equal(s.totals.netPayable, NET, 'the seeded week nets the PDF cases − the refund fee');

  const data = ok(await get(`/overview?statementId=${s._id}`));
  assert.equal(data.isEmpty, false);
  assert.equal(data.nextPayout.statementId, String(s._id));
  assert.equal(data.nextPayout.netPaise, NET);
  assert.equal(data.nextPayout.transferStatus, 'not_scheduled');
  assert.equal(data.nextPayout.ownerView.status, 'Not scheduled');

  // Still clearing: the order inside T+2 (its net) and the undelivered one (its projected net).
  assert.equal(data.stillClearing.orderCount, 2);
  assert.equal(data.stillClearing.amountPaise, 30250 * 2);

  // Yulo money = customer-paid platform fee + delivery on online money only: 1200+3000, 1200, 1200.
  assert.equal(data.yuloMoney.amountPaise, 4200 + 1200 + 1200);

  assert.deepEqual(
    { last4: data.payoutDestination.last4, status: data.payoutDestination.status, holder: data.payoutDestination.holderName, f: data.payoutDestination.frequency },
    { last4: '4417', status: 'verified', holder: 'Annapurna Kitchen', f: 'weekly' }
  );
  assert.equal(data.statements.length, 1);

  const byId = new Map(data.recentOrders.rows.map((r) => [String(r.id), r]));
  assert.equal(data.recentOrders.total, 7);
  assert.deepEqual(
    { pt: byId.get(String(ids.case1)).paymentType, paid: byId.get(String(ids.case1)).customerPaidPaise, net: byId.get(String(ids.case1)).youReceivePaise, st: byId.get(String(ids.case1)).status },
    { pt: 'online', paid: 35700, net: 30250, st: 'eligible' }
  );
  assert.equal(byId.get(String(ids.case2)).youReceivePaise, 27355);
  assert.deepEqual(
    { pt: byId.get(String(ids.onlineBill)).paymentType, net: byId.get(String(ids.onlineBill)).youReceivePaise },
    { pt: 'dine_in_online', net: 30355 }
  );
  const counter = byId.get(String(ids.counterBill));
  assert.deepEqual(
    { pt: counter.paymentType, method: counter.counterMethod, paid: counter.customerPaidPaise, net: counter.youReceivePaise },
    { pt: 'dine_in_counter', method: 'upi', paid: null, net: -1242 }
  );
  assert.deepEqual({ st: byId.get(String(ids.refunded)).status, net: byId.get(String(ids.refunded)).youReceivePaise }, { st: 'refunded', net: -1138 });
  assert.equal(byId.get(String(ids.clearing)).status, 'pending');
  assert.equal(byId.get(String(ids.undelivered)).status, 'pending');
  assert.equal(byId.get(String(ids.undelivered)).youReceivePaise, 30250, 'projected');

  const pending = ok(await get('/overview?status=pending'));
  assert.equal(pending.recentOrders.rows.length, 2);
});

test('status derivation follows the payout: eligible → settled once paid; history and statement agree', async () => {
  const s = await statementOf();
  await settlementService.scheduleSettlement(s._id, { scheduledFor: '2026-10-26' }, admin._id);
  let data = ok(await get('/overview'));
  assert.equal(data.nextPayout.transferStatus, 'scheduled');
  assert.ok(data.nextPayout.scheduledFor);
  assert.match(data.nextPayout.ownerView.message, /Scheduled · Mon 26 Oct 2026/);

  await settlementService.releaseSettlement(s._id, admin._id);
  await settlementService.recordPayoutPaid(s._id, { bankReference: 'UTR-OWNER-1' }, admin._id);

  data = ok(await get('/overview'));
  assert.equal(data.nextPayout, null);
  assert.equal(data.nextPayoutReason, 'no_open_statement');
  const case1 = data.recentOrders.rows.find((r) => String(r.id) === String(ids.case1));
  assert.equal(case1.status, 'settled');

  const hist = ok(await get('/history'));
  assert.equal(hist.kpis.totalPaidPaise, NET);
  assert.equal(hist.kpis.availableStatements, 1);
  assert.equal(hist.kpis.upcomingEligible, null);
  assert.equal(hist.rows[0].transferStatus, 'paid');
  assert.ok(hist.rows[0].transferDate);
  assert.equal(ok(await get('/history?transferStatus=scheduled')).rows.length, 0);

  const st = ok(await get(`/statements/${s._id}`));
  assert.equal(st.statement.bankReference, 'UTR-OWNER-1');
  assert.equal(st.statement.destinationLast4, '4417');
  assert.equal(st.ownerView.status, 'Paid');
  assert.deepEqual(
    st.timeline.map((t) => [t.key, t.done]),
    [['prepared', true], ['eligible', true], ['scheduled', true], ['released', true], ['paid', true]]
  );
  assert.equal(st.calculation.netPayoutPaise, NET);
  assert.equal(st.calculation.lines.reduce((n, l) => n + l.amountPaise, 0), NET, 'the lines add up');
  assert.equal(st.yuloMoneyPaise, 4200 + 1200 + 1200);
  assert.equal(st.orders.length, 5);
  assert.equal(st.hasEntries, true);
});

test('statement on hold: the reason label, never the staff note', async () => {
  const s = await statementOf();
  await settlementService.holdSettlement(s._id, admin._id, { reason: 'dispute_review', note: 'call the owner first' });
  const st = ok(await get(`/statements/${s._id}`));
  assert.equal(st.statement.eligibility, 'on_hold');
  assert.equal(st.statement.holdLabel, 'Dispute review');
  assert.ok(!JSON.stringify(st).includes('call the owner first'));
  assert.ok(st.timeline.some((t) => t.key === 'on_hold'));
});

test('order payment detail: customer bill, restaurant settlement, clearance, linked statement', async () => {
  const s = await statementOf();
  const d = ok(await get(`/orders/${ids.case1}`));
  assert.equal(d.paymentType, 'online');
  assert.equal(d.status, 'eligible');
  assert.equal(d.customerBill.paidAmountPaise, 35700);
  const bill = Object.fromEntries(d.customerBill.lines.map((l) => [l.key, l]));
  assert.equal(bill.price.amountPaise, 30000);
  assert.equal(bill.gst.amountPaise, 1500);
  assert.deepEqual([bill.delivery.basePaise, bill.delivery.gstPaise], [2542, 458]);
  assert.deepEqual([bill.platformFee.basePaise, bill.platformFee.gstPaise], [1017, 183]);
  const rs = Object.fromEntries(d.restaurantSettlement.lines.map((l) => [l.key, l]));
  assert.equal(rs.priceInclGst.amountPaise, 31500);
  assert.deepEqual(
    [rs.settlementFee.amountPaise, rs.settlementFee.percent, rs.settlementFee.onAmountPaise, rs.settlementFee.basePaise + rs.settlementFee.gstPaise],
    [-1250, 3.5, 35700, 1250]
  );
  assert.equal(d.restaurantSettlement.receivedPaise, 30250);
  assert.equal(d.yuloMoneyPaise, 4200);
  assert.equal(d.linkedStatement.statementId, String(s._id));
  assert.equal(d.linkedStatement.contributionPaise, 30250);
  assert.equal(d.clearance.stage, 'in_statement');
  assert.ok(d.otherFeeCategories.every((c) => c.amountPaise === 0));

  const free = ok(await get(`/orders/${ids.case2}`));
  assert.equal(free.restaurantSettlement.lines.find((l) => l.key === 'freeDelivery').amountPaise, -3000);
  assert.equal(free.restaurantSettlement.receivedPaise, 27355);

  const pending = ok(await get(`/orders/${ids.undelivered}`));
  assert.deepEqual([pending.status, pending.clearance.stage, pending.linkedStatement], ['pending', 'awaiting_delivery', null]);
  assert.equal(pending.restaurantSettlement.projected, true);
  assert.equal(pending.restaurantSettlement.receivedPaise, 30250);

  const refunded = ok(await get(`/orders/${ids.refunded}`));
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refund.status, 'processed');
  assert.equal(refunded.restaurantSettlement.receivedPaise, -1138);
  assert.ok(refunded.restaurantSettlement.lines.some((l) => l.key === 'refundAdjustment'));
});

test('bill payment detail: dine-in online, and a counter bill is a debit with no Yulo money', async () => {
  const online = ok(await get(`/bills/${ids.onlineBill}`));
  assert.deepEqual([online.paymentType, online.tableNumber, online.restaurantSettlement.receivedPaise, online.yuloMoneyPaise], ['dine_in_online', '4', 30355, 1200]);
  assert.ok(!online.customerBill.lines.some((l) => l.key === 'delivery'), 'no delivery on a dine-in bill');

  const counter = ok(await get(`/bills/${ids.counterBill}`));
  assert.equal(counter.paymentType, 'dine_in_counter');
  assert.equal(counter.customerBill.paidAtTable, true);
  assert.equal(counter.customerBill.counterMethod, 'upi');
  assert.equal(counter.restaurantSettlement.receivedPaise, -1242);
  assert.equal(counter.yuloMoneyPaise, 0);
});

test("owner A can't read B's statement, order or bill; B's overview is empty", async () => {
  const s = await statementOf();
  assert.equal((await get(`/statements/${s._id}`, otherOwner)).status, 404);
  assert.equal((await get(`/orders/${ids.case1}`, otherOwner)).status, 404);
  assert.equal((await get(`/bills/${ids.onlineBill}`, otherOwner)).status, 404);
  // …and the other way round: owner A on B's restaurant id is refused by authorizeRestaurant.
  const cross = await srv.get(`/api/owner/${other._id}/payments/overview`, ownerHeaders(owner));
  assert.equal(cross.status, 403);

  const empty = ok(await get('/overview', otherOwner));
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.nextPayout, null);
  assert.equal(empty.nextPayoutReason, 'no_eligible_earnings');
  assert.deepEqual(empty.stillClearing, { amountPaise: 0, orderCount: 0 });
  assert.equal(empty.recentOrders.total, 0);
});

test('bank & payout settings: masked account, change request, next scheduled payout', async () => {
  const s = await statementOf();
  await settlementService.scheduleSettlement(s._id, { scheduledFor: '2026-10-26' }, admin._id);
  await Restaurant.updateOne(
    { _id: restaurant._id },
    {
      $set: {
        'payoutAccount.pendingChange': {
          accountHolderName: 'Annapurna Kitchen',
          accountNumberEncrypted: encryptField('99998888777'),
          accountNumberLast4: '8777',
          ifsc: 'ICIC0001234',
          accountType: 'current',
          status: 'awaiting_restaurant',
          requestedAt: new Date(),
          infoRequest: { message: 'Please upload a cancelled cheque', at: new Date(), by: admin._id },
        },
      },
    }
  );
  const data = ok(await get('/settings'));
  assert.equal(data.account.accountNumberLast4, '4417');
  assert.equal(data.account.status, 'verified');
  assert.equal(data.account.pendingChange.status, 'awaiting_restaurant');
  assert.equal(data.account.pendingChange.infoRequest.message, 'Please upload a cancelled cheque');
  assert.ok(!JSON.stringify(data).includes('99998888777'));
  assert.ok(!JSON.stringify(data).includes(String(admin._id)), 'never which admin asked');
  assert.equal(data.nextScheduledPayout.statementId, String(s._id));
  assert.equal(data.nextScheduledPayout.netPaise, NET);
  assert.equal(data.nextScheduledPayout.destinationLast4, '4417');
});

test('bad ids and query values answer 400', async () => {
  assert.equal((await get('/statements/not-an-id')).status, 400);
  assert.equal((await get('/orders/123')).status, 400);
  assert.equal((await get('/overview?status=weird')).status, 400);
  assert.equal((await get('/history?transferStatus=nope')).status, 400);
});

test('next payout skips a carried-forward week and prefers the payout already scheduled', async () => {
  const seeded = await statementOf();
  const week = (n) => ({ start: new Date(seeded.periodStart.getTime() + n * 7 * DAY), end: new Date(seeded.periodEnd.getTime() + n * 7 * DAY) });
  // A newer week that ended negative: carried forward, nothing owed.
  await RestaurantSettlement.collection.insertOne({
    restaurantId: restaurant._id,
    periodStart: week(1).start,
    periodEnd: week(1).end,
    status: 'on_hold',
    holdReason: 'NEGATIVE_BALANCE_CARRIED_FORWARD',
    totals: { netPayable: 0, carryForwardOut: 500 },
    payout: {},
  });
  let next = ok(await get('/overview')).nextPayout;
  assert.equal(String(next.statementId), String(seeded._id), 'the carried-forward week is not the next payout');

  // An older week already scheduled beats the not-yet-scheduled one.
  const scheduledFor = new Date(CLOCK.getTime() + 3 * DAY);
  const { insertedId } = await RestaurantSettlement.collection.insertOne({
    restaurantId: restaurant._id,
    periodStart: week(-1).start,
    periodEnd: week(-1).end,
    status: 'approved',
    totals: { netPayable: 12345 },
    payout: { scheduledFor },
  });
  next = ok(await get('/overview')).nextPayout;
  assert.equal(String(next.statementId), String(insertedId));
  assert.equal(next.netPaise, 12345);
  assert.equal(new Date(next.scheduledFor).getTime(), scheduledFor.getTime());
});
