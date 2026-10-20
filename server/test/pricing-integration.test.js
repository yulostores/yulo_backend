// B3 — the pricing engine wired into every place a customer price is shown or frozen: cart
// preview, checkout summary, order placement (and that it equals the summary), the delivery
// zone and address checks, dine-in bills and the bill view. In-memory MongoDB; fake Razorpay.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, NEARBY_DROP } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { createVersion, __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const billingService = await import('../services/billing.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { generateTokens } = await import('../services/auth.service.js');

const RESTAURANT_AT = [77.59, 12.97];
const FAR_AWAY = [77.9, 12.97]; // ~34 km — beyond any zone
const located = (coordinates, extra = {}) => ({
  street: '1 Test Road',
  city: 'Bengaluru',
  pincode: '560001',
  location: { type: 'Point', coordinates },
  locationSource: 'map_pin',
  ...extra,
});

let mongo;
let srv;
let restaurant;
let dish;
let customer;
let headers;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  __setRazorpayForTests(createFakeRazorpay());

  const owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
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
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  dish = await MenuItem.create({
    restaurantId: restaurant._id,
    categoryId: category._id,
    name: 'Thali',
    foodType: 'veg',
    sellingPrice: 300,
  });
  customer = await User.create({
    name: 'Asha',
    phone: '9876543210',
    role: 'customer',
    savedAddresses: [located(NEARBY_DROP, { isDefault: true })],
  });
  headers = { authorization: `Bearer ${generateTokens(customer._id, 'customer').accessToken}` };
  await Cart.create({
    userId: customer._id,
    restaurantId: restaurant._id,
    items: [{ menuItemId: dish._id, name: 'Thali', unitPrice: 300, mrpUnitPrice: 300, qty: 1, foodType: 'veg' }],
  });
});

const setDefaultAddress = (address) =>
  User.updateOne({ _id: customer._id }, { $set: { savedAddresses: [{ ...address, isDefault: true }] } });

const placeOnline = (body = {}) =>
  srv.request('POST', '/api/orders/checkout', { headers, body: { paymentMethod: 'online', ...body } });

// ── Cart preview ──────────────────────────────────────────────────────────────

test('cart preview is priced by the engine against the default address', async () => {
  const res = await srv.get('/api/cart', headers);
  assert.equal(res.status, 200);
  const { bill } = res.body.data;

  // ~1.09 km → 1.1 km × ₹8 = ₹8.80 + 18 % GST ₹1.58 = ₹10.38
  assert.equal(bill.charges.delivery.distanceKm, 1.1);
  assert.equal(bill.charges.delivery.customerPays, 1038);
  assert.equal(bill.deliveryIssue, null);
  // Legacy rupee fields the app renders, derived from the same breakdown.
  assert.equal(bill.itemTotal, 300);
  assert.equal(bill.tax, 15);
  assert.equal(bill.deliveryFee, 10.38);
  assert.equal(bill.platformFee, 12);
  assert.equal(bill.grandTotal, bill.charges.grandTotal / 100);
  assert.equal(bill.charges.grandTotal % 100, 0, 'rounded to the rupee');
});

test('cart preview with an unlocated address: delivery "Calculated at checkout", not in the total', async () => {
  await setDefaultAddress({ label: 'home' }); // no postal line → nothing to geocode
  const { bill } = (await srv.get('/api/cart', headers)).body.data;
  assert.equal(bill.deliveryIssue, 'ADDRESS_NOT_LOCATED');
  assert.equal(bill.charges.delivery.pending, true);
  const line = bill.charges.lines.find((l) => l.key === 'delivery_fee');
  assert.equal(line.sublabel, 'Calculated at checkout');
  assert.equal(bill.grandTotal, 327);
});

// ── Checkout summary ⇄ placement ──────────────────────────────────────────────

test('order placed via checkout has exactly the charges the checkout summary showed', async () => {
  const summary = await srv.get('/api/checkout/summary', headers);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.data.deliveryIssue, null);
  const shown = summary.body.data.bill.charges;

  const placed = await placeOnline();
  assert.equal(placed.status, 201, JSON.stringify(placed.body));

  const order = await Order.findById(placed.body.data.orderId).lean();
  assert.deepEqual(order.charges, shown);
  assert.equal(order.grandTotal, shown.grandTotal / 100);
  assert.equal(order.paymentAmountPaise, shown.grandTotal, 'Razorpay asked for exactly what was shown');
  assert.equal(order.deliveryFee, 10.38);
  assert.equal(order.platformFee, 12);
  assert.equal(order.tax, 15);
  assert.equal(order.subtotal, 300);
});

test('checkout with a tip: summary total + tip, tip frozen as its own line', async () => {
  const summary = await srv.get('/api/checkout/summary', headers);
  const placed = await placeOnline({ tip: 20 });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = await Order.findById(placed.body.data.orderId).lean();
  assert.equal(order.charges.grandTotal, summary.body.data.bill.charges.grandTotal + 2000);
  assert.equal(order.tip, 20);
  assert.equal(order.charges.lines.find((l) => l.key === 'tip').amountPaise, 2000);
});

test('free-delivery threshold: customer pays no delivery; restaurant-paid delivery recorded', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'delivery.freeThreshold': 250 } });
  const placed = await placeOnline();
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = await Order.findById(placed.body.data.orderId).lean();
  assert.equal(order.charges.delivery.paidBy, 'restaurant');
  assert.equal(order.charges.delivery.total, 1038);
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.grandTotal, 327);
});

test('non-GST restaurant: no food GST on the order', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { gstRegistered: false } });
  const placed = await placeOnline();
  const order = await Order.findById(placed.body.data.orderId).lean();
  assert.equal(order.tax, 0);
  assert.equal(order.charges.food.gstPercent, 0);
});

test('out of the delivery zone → 400 OUT_OF_DELIVERY_RANGE, summary warns, nothing created', async () => {
  await setDefaultAddress(located(FAR_AWAY));
  const summary = await srv.get('/api/checkout/summary', headers);
  assert.equal(summary.body.data.deliveryIssue, 'OUT_OF_DELIVERY_RANGE');
  assert.ok(summary.body.data.deliveryIssueMessage);

  const placed = await placeOnline();
  assert.equal(placed.status, 400);
  assert.equal(placed.body.code, 'OUT_OF_DELIVERY_RANGE');
  assert.equal(await Order.countDocuments(), 0);
});

test('unlocated address → 400 ADDRESS_NOT_LOCATED at checkout, nothing created', async () => {
  await setDefaultAddress({ label: 'home' });
  const placed = await placeOnline();
  assert.equal(placed.status, 400);
  assert.equal(placed.body.code, 'ADDRESS_NOT_LOCATED');
  assert.equal(await Order.countDocuments(), 0);
});

test('a Finance Settings change reprices new orders; placed orders keep their snapshot', async () => {
  const first = await placeOnline();
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const admin = await User.create({ name: 'Admin', email: 'a@test.local', role: 'admin' });
  await createVersion({ patch: { customerPlatformFee: 1500 } }, admin._id);

  // Checkout emptied the cart; fill it again for a second order.
  await Cart.updateOne(
    { userId: customer._id },
    {
      $set: {
        restaurantId: restaurant._id,
        items: [{ menuItemId: dish._id, name: 'Thali', unitPrice: 300, mrpUnitPrice: 300, qty: 1, foodType: 'veg' }],
      },
    }
  );
  const second = await placeOnline();
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const [firstOrder, secondOrder] = await Promise.all([
    Order.findById(first.body.data.orderId).lean(),
    Order.findById(second.body.data.orderId).lean(),
  ]);
  assert.equal(firstOrder.charges.platformFee.total, 1200, 'frozen at placement');
  assert.equal(secondOrder.charges.platformFee.total, 1500, 'new orders use the new version');
  assert.notEqual(firstOrder.charges.settingsVersionId, secondOrder.charges.settingsVersionId);
});

// ── Dine-in ───────────────────────────────────────────────────────────────────

const seatTableWithRounds = async (prices) => {
  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'T1' });
  const session = await TableSession.create({ restaurantId: restaurant._id, tableId: table._id });
  for (const [i, price] of prices.entries()) {
    const order = await Order.create({
      restaurantId: restaurant._id,
      tableSessionId: session._id,
      tableId: table._id,
      type: 'dine_in',
      placedBy: 'guest',
      batchNumber: i + 1,
      items: [{ menuItemId: dish._id, name: 'Thali', price, quantity: 1 }],
      subtotal: price,
      status: 'served',
    });
    await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
  }
  return { table, session };
};

test('PDF Case 3 via a real bill: ₹300 dine-in → ₹327 with GST and one platform fee', async () => {
  const { table, session } = await seatTableWithRounds([300]);
  const bill = await billingService.assembleBill(session._id);
  assert.equal(bill.grandTotal, 327);
  assert.equal(bill.gstAmount, 15);
  assert.equal(bill.platformFee, 12);
  assert.equal(bill.charges.grandTotal, 32700);

  // The guest's public bill view exposes the breakdown alongside the old rupee summary.
  const res = await srv.get(`/api/restaurants/${restaurant._id}/tables/${table._id}/bill`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.bill.charges.grandTotal, 327);
  assert.equal(res.body.data.bill.charges.platformFee, 12);
  assert.equal(res.body.data.bill.chargeBreakdown.grandTotal, 32700);
  assert.ok(Array.isArray(res.body.data.bill.chargeBreakdown.lines));
});

test('dine-in: platform fee once per bill by default, once per round when configured', async () => {
  const { session } = await seatTableWithRounds([200, 100]);
  const perBill = await billingService.assembleBill(session._id);
  assert.equal(perBill.platformFee, 12);
  assert.equal(perBill.grandTotal, 327);

  const admin = await User.create({ name: 'Admin', email: 'a2@test.local', role: 'admin' });
  await createVersion({ patch: { dineInPlatformFeeUnit: 'order' } }, admin._id);
  const perOrder = await billingService.assembleBill(session._id);
  assert.equal(perOrder.platformFee, 24);
  assert.equal(perOrder.grandTotal, 339);
});

test('dine-in: restaurant service charge kept; non-GST restaurant charges no food GST', async () => {
  await Restaurant.updateOne(
    { _id: restaurant._id },
    { $set: { 'settings.serviceChargePercent': 10, gstRegistered: false } }
  );
  const { session } = await seatTableWithRounds([300]);
  const bill = await billingService.assembleBill(session._id);
  assert.equal(bill.serviceChargeAmount, 30);
  assert.equal(bill.gstAmount, 0);
  assert.equal(bill.grandTotal, 300 + 30 + 12);
});

test('dine-in discount: GST on the food after the discount', async () => {
  const { Discount } = { Discount: (await import('../models/Discount.js')).default };
  await Discount.create({
    restaurantId: restaurant._id,
    type: 'flat_amount',
    offerName: '₹100 off',
    code: 'HUNDRED',
    flatAmount: 100,
    status: 'active',
    applicableTo: 'both',
  });
  const { session } = await seatTableWithRounds([300]);
  const bill = await billingService.assembleBill(session._id);
  const discounted = await billingService.applyDiscount({
    billId: bill._id,
    discountCode: 'HUNDRED',
    restaurantId: restaurant._id,
  });
  assert.equal(discounted.discountTotal, 100);
  assert.equal(discounted.gstAmount, 10, '5 % of ₹200');
  assert.equal(discounted.grandTotal, 200 + 10 + 12);
});
