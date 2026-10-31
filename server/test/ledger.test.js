// B4 — the restaurant ledger through the real flows: an online order delivered (kitchen or
// rider side, idempotent), dine-in bills paid online and at the counter, COD left alone, the
// cancel-after-preparation hook, rider pay frozen at acceptance, the COD amount, and the owner
// and admin read APIs. In-memory MongoDB; no gateway calls.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const kitchenService = await import('../services/kitchen.service.js');
const billingService = await import('../services/billing.service.js');
const ledgerService = await import('../services/ledger.service.js');
const { buildOfferPayload } = await import('../services/deliveryAssignment.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { generateTokens, generatePartnerTokens } = await import('../services/auth.service.js');
const { clearanceTime } = await import('../utils/workingDays.js');
const { weekBounds } = await import('../utils/week.js');

const RESTAURANT_AT = [77.59, 12.97];
// 3.4 km due east of the restaurant (1° of longitude ≈ 108.48 km at this latitude).
const DROP_3_4_KM = [77.59 + 3.4 / 108.48, 12.97];

let mongo;
let srv;
let owner;
let otherOwner;
let admin;
let restaurant;
let partner;

before(async () => {
  mongo = await startMemoryMongo();
  await RestaurantLedgerEntry.init();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  owner = await User.create({ name: 'Owner A', email: 'a@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'Owner B', email: 'b@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    gstRegistered: true,
    delivery: { radiusKm: 10 },
    settings: { serviceChargePercent: 0 },
  });
  await Restaurant.create({
    ownerId: otherOwner._id,
    name: 'Other Place',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
  });
  partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'active' });
});

const bearer = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const partnerHeaders = () => ({ authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` });

// A delivery order priced by the real engine, paid online with a known Razorpay fee.
const paidOnlineOrder = async (overrides = {}) => {
  const settings = await getActiveSettings();
  const charges = computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant,
    distanceKm: 3.4,
    tipPaise: overrides.tipPaise ?? 0,
    settings,
  });
  return Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    grandTotal: charges.grandTotal / 100,
    tip: (overrides.tipPaise ?? 0) / 100,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    razorpayFee: 1100,
    razorpayTax: 168,
    status: 'out_for_delivery',
    deliveryAddress: { street: '1 Test Road', city: 'Bengaluru', coordinates: DROP_3_4_KM },
    deliveryAssignment: { partnerId: partner._id, status: 'picked_up' },
    ...overrides.fields,
  });
};

// The non-rider delivered path (updateOrderStatus). A rider holds these orders, so only Yulo
// support may close one this way — the kitchen is refused (RIDER_CONFIRMS_DELIVERY).
const deliverViaKitchen = (order) =>
  kitchenService.updateOrderStatus({
    orderId: order._id,
    currentStatus: 'out_for_delivery',
    newStatus: 'delivered',
    actor: { role: 'admin' },
  });

// ── Orders ────────────────────────────────────────────────────────────────────

test('online order delivered → one order_earning credit = restaurant net; financials frozen', async () => {
  const order = await paidOnlineOrder();
  await deliverViaKitchen(order);

  const entries = await RestaurantLedgerEntry.find({ orderId: order._id }).lean();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.type, 'order_earning');
  assert.equal(entry.direction, 'credit');

  const saved = await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean();
  const c = saved.charges;
  const settlement = Math.round((c.grandTotal * 3.5) / 100);
  assert.equal(entry.amountPaise, c.grandTotal - c.platformFee.total - c.delivery.customerPays - settlement);
  assert.deepEqual(saved.financials, entry.breakdown);
  assert.equal(saved.financials.gateway.total, 1100);
  assert.equal(saved.financials.yuloSettlementMargin, settlement - 1100);
  assert.ok(entry.eligibleAt.getTime() >= saved.deliveredAt.getTime() - 1000);
});

test('idempotent: repeated and simultaneous delivery hooks → still exactly one credit', async () => {
  const order = await paidOnlineOrder();
  await deliverViaKitchen(order);
  const delivered = await Order.findById(order._id);
  // A retried request, the rider-side hook firing after the kitchen's, and two at once.
  await ledgerService.onOrderDelivered(delivered);
  await Promise.all([ledgerService.onOrderDelivered(delivered), ledgerService.onOrderDelivered(delivered)]);

  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id }), 1);

  const fresh = await paidOnlineOrder();
  await Order.updateOne({ _id: fresh._id }, { $set: { status: 'delivered', deliveredAt: new Date() } });
  const doc = await Order.findById(fresh._id);
  await Promise.all([1, 2, 3, 4].map(() => ledgerService.onOrderDelivered(doc)));
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: fresh._id }), 1);
});

test('rider-side delivery alone also credits the restaurant', async () => {
  const order = await paidOnlineOrder();
  const res = await srv.request('POST', `/api/partner/orders/${order._id}/deliver`, {
    headers: partnerHeaders(),
    body: {},
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id, type: 'order_earning' }), 1);
});

test('COD and unpaid online orders produce no ledger row', async () => {
  const cod = await paidOnlineOrder({
    fields: { paymentMethod: 'cash', paymentChannel: 'cod', paymentStatus: 'pending_cod' },
  });
  await deliverViaKitchen(cod);
  const unpaid = await paidOnlineOrder({ fields: { paymentStatus: 'pending' } });
  await ledgerService.onOrderDelivered(unpaid);
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 0);
});

// B12 changed "eligible at cancellation" to "eligible at the later of cancellation and the payment's
// T+2 working-day clearance" — the money must have reached Yulo before it is paid out.
test('customer cancelling after preparation started → restaurant credited, eligible once cancelled and cleared', async () => {
  const order = await paidOnlineOrder({ fields: { status: 'preparing', deliveryAssignment: {} } });
  const cancelled = await kitchenService.updateOrderStatus({
    orderId: order._id,
    currentStatus: 'preparing',
    newStatus: 'cancelled',
    actor: { role: 'customer' },
    reason: 'Changed my mind',
  });
  const entry = await RestaurantLedgerEntry.findOne({ orderId: order._id }).lean();
  assert.ok(entry, 'credited');
  assert.equal(entry.type, 'order_earning');
  const paid = await Order.findById(order._id).select('paidAt createdAt').lean();
  const cleared = clearanceTime(paid.paidAt ?? paid.createdAt);
  assert.equal(entry.eligibleAt.getTime(), Math.max(cancelled.cancelledAt.getTime(), cleared.getTime()));
  assert.equal(entry.clearsAt.getTime(), entry.eligibleAt.getTime());
  assert.match(entry.note, /no refund/);
});

test('a restaurant cancelling a paid order does NOT credit it', async () => {
  const order = await paidOnlineOrder({ fields: { status: 'preparing', deliveryAssignment: {} } });
  await kitchenService.updateOrderStatus({
    orderId: order._id,
    currentStatus: 'preparing',
    newStatus: 'cancelled',
    actor: { role: 'owner' },
  });
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 0);
});

// ── Dine-in bills ─────────────────────────────────────────────────────────────

const servedTable = async () => {
  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'T1' });
  const session = await TableSession.create({ restaurantId: restaurant._id, tableId: table._id });
  const order = await Order.create({
    restaurantId: restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    type: 'dine_in',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
  return billingService.assembleBill(session._id);
};

test('dine-in bill paid at the counter → counter_platform_fee debit of ₹12.42', async () => {
  const bill = await servedTable();
  assert.equal(bill.grandTotal, 327);
  await billingService.markPaid({ billId: bill._id, restaurantId: restaurant._id, paymentMethod: 'cash' });

  const entry = await RestaurantLedgerEntry.findOne({ billId: bill._id }).lean();
  assert.equal(entry.type, 'counter_platform_fee');
  assert.equal(entry.direction, 'debit');
  assert.equal(entry.amountPaise, 1242);
});

test('dine-in bill paid online → dine_in_earning credit of ₹303.55', async () => {
  const bill = await servedTable();
  await bill.updateOne({ $set: { razorpayFee: 1040, razorpayTax: 159 } });
  await billingService.markPaid({ billId: bill._id, restaurantId: restaurant._id, paymentMethod: 'online' });

  const entry = await RestaurantLedgerEntry.findOne({ billId: bill._id }).lean();
  assert.equal(entry.type, 'dine_in_earning');
  assert.equal(entry.direction, 'credit');
  assert.equal(entry.amountPaise, 30355);
  const { default: Bill } = await import('../models/Bill.js');
  const saved = await Bill.findById(bill._id).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(saved.financials.yuloSettlementMargin, 1145 - 1040);
});

// ── Rider pay ─────────────────────────────────────────────────────────────────

test('rider pay is frozen when the rider accepts: base + km beyond 2 km + tip', async () => {
  const order = await paidOnlineOrder({
    tipPaise: 3000,
    fields: {
      status: 'confirmed',
      deliveryAssignment: {
        status: 'unassigned',
        offeredTo: partner._id,
        offerStatus: 'offered',
        offerExpiresAt: new Date(Date.now() + 60_000),
      },
    },
  });

  const res = await srv.request('POST', `/api/partner/orders/${order._id}/accept`, { headers: partnerHeaders() });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const e = (await Order.findById(order._id).select('+razorpayFee +razorpayTax +financials').lean()).deliveryAssignment.earningsBreakdown;
  assert.equal(e.distanceKm, 3.4);
  assert.equal(e.basePay, 20);
  assert.equal(e.distancePay, 7); // 1.4 km × ₹5
  assert.equal(e.tip, 30);
  assert.ok(e.computedAt);
});

test('COD offer asks the rider to collect the full grand total, not the food subtotal', async () => {
  const order = await paidOnlineOrder({ fields: { paymentMethod: 'cash', paymentChannel: 'cod', paymentStatus: 'pending_cod' } });
  const offer = await buildOfferPayload(order.toObject(), partner.toObject());
  assert.equal(offer.payment, 'cod');
  assert.equal(offer.codAmount, order.grandTotal);
  assert.notEqual(offer.codAmount, order.subtotal);
});

// ── Read APIs ─────────────────────────────────────────────────────────────────

test("owner ledger: own rows and totals, never Razorpay's fee, Yulo's margin or rider pay", async () => {
  const order = await paidOnlineOrder();
  await deliverViaKitchen(order);
  const bill = await servedTable();
  await billingService.markPaid({ billId: bill._id, restaurantId: restaurant._id, paymentMethod: 'cash' });

  const res = await srv.get(`/api/owner/${restaurant._id}/ledger`, bearer(owner, 'restaurant_owner'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { entries, totals, total } = res.body.data;
  assert.equal(total, 2);
  for (const entry of entries) {
    assert.ok(!('gateway' in entry.breakdown));
    assert.ok(!('yuloSettlementMargin' in entry.breakdown));
    assert.ok(!('riderPay' in entry.breakdown));
    assert.ok('restaurantNet' in entry.breakdown);
  }
  const credit = entries.find((e) => e.type === 'order_earning').amountPaise;
  assert.equal(totals.netPaise, credit - 1242);

  const counterOnly = await srv.get(
    `/api/owner/${restaurant._id}/ledger?type=counter_platform_fee`,
    bearer(owner, 'restaurant_owner')
  );
  assert.equal(counterOnly.body.data.total, 1);

  // The week filter is on eligibleAt — since B12 the online credit counts from its T+2 clearance,
  // which can fall in next week; the cash bill's debit counts at once.
  const thisWeek = await srv.get(
    `/api/owner/${restaurant._id}/ledger?week=${new Date().toISOString()}`,
    bearer(owner, 'restaurant_owner')
  );
  const { start, end } = weekBounds(new Date(), (await getActiveSettings()).settlementCycle);
  const inWeek = await RestaurantLedgerEntry.countDocuments({ restaurantId: restaurant._id, eligibleAt: { $gte: start, $lte: end } });
  assert.ok(inWeek >= 1, 'the counter debit is this week');
  assert.equal(thisWeek.body.data.total, inWeek);
  const lastYear = await srv.get(
    `/api/owner/${restaurant._id}/ledger?week=2025-01-01`,
    bearer(owner, 'restaurant_owner')
  );
  assert.equal(lastYear.body.data.total, 0);
});

test("owner B cannot read owner A's ledger", async () => {
  const res = await srv.get(`/api/owner/${restaurant._id}/ledger`, bearer(otherOwner, 'restaurant_owner'));
  assert.equal(res.status, 403);
});

test('admin breakdown: frozen financials with gateway & margin; projection before delivery; admin only', async () => {
  const delivered = await paidOnlineOrder();
  await deliverViaKitchen(delivered);
  const res = await srv.get(`/api/admin/finance/orders/${delivered._id}/breakdown`, bearer(admin, 'admin'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.financials.gateway.total, 1100);
  assert.ok('yuloSettlementMargin' in res.body.data.financials);
  assert.equal(res.body.data.projected, null);
  assert.equal(res.body.data.ledgerEntries.length, 1);

  const pending = await paidOnlineOrder();
  const preview = await srv.get(`/api/admin/finance/orders/${pending._id}/breakdown`, bearer(admin, 'admin'));
  assert.equal(preview.body.data.financials, null);
  assert.ok(preview.body.data.projected.restaurantNet > 0);

  const bill = await servedTable();
  await billingService.markPaid({ billId: bill._id, restaurantId: restaurant._id, paymentMethod: 'upi' });
  const billRes = await srv.get(`/api/admin/finance/bills/${bill._id}/breakdown`, bearer(admin, 'admin'));
  assert.equal(billRes.body.data.financials.restaurantNet, -1242);

  const asOwner = await srv.get(`/api/admin/finance/orders/${delivered._id}/breakdown`, bearer(owner, 'restaurant_owner'));
  assert.equal(asOwner.status, 403);
});
