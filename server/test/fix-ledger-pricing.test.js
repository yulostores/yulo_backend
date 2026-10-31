// Regression tests for the ledger / pricing review fixes: counter-paid takeaway orders owe the
// platform fee, internal settlement figures never reach riders or chefs, the checkout summary
// prices the picked address (and the tip), Finance Settings versions don't undo each other, a
// patch doesn't reset the payout file format, the ledger uses the settings version that priced
// the order, the admin GSTIN rule can't be bypassed, and the tip is capped.
// In-memory MongoDB; fake Razorpay, never the real one.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, NEARBY_DROP } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const financeSettings = await import('../services/financeSettings.service.js');
const { computeCustomerCharges, MAX_TIP_PAISE } = await import('../services/charges.service.js');
const kitchenService = await import('../services/kitchen.service.js');
const ledgerService = await import('../services/ledger.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: Order } = await import('../models/Order.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: FinanceSettings } = await import('../models/FinanceSettings.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { generateTokens, generateStaffToken, generatePartnerTokens } = await import('../services/auth.service.js');

const { createVersion, getActiveSettings, financeSettingsPatchSchema, __resetFinanceSettingsCache } = financeSettings;

const RESTAURANT_AT = [77.59, 12.97];
// ~6 km due east (1° of longitude ≈ 108.48 km at this latitude).
const FAR_DROP = [77.59 + 6 / 108.48, 12.97];
const DAY = 24 * 60 * 60 * 1000;

let mongo;
let srv;
let admin;
let restaurant;
let partner;
let customer;
let customerHeaders;

before(async () => {
  mongo = await startMemoryMongo();
  await RestaurantLedgerEntry.init();
  await FinanceSettings.init();
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
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    gstRegistered: true,
    delivery: { radiusKm: 10 },
    settings: { serviceChargePercent: 0, gstNumber: '29ABCDE1234F1Z5', panNumber: 'ABCDE1234F' },
  });
  partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'active' });
});

const adminHeaders = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });
const partnerHeaders = () => ({ authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` });

const pricedOrder = async ({ type = 'delivery', fields = {}, settings } = {}) => {
  const active = settings ?? (await getActiveSettings());
  const charges = computeCustomerCharges({
    orderType: type,
    foodSubtotalPaise: 30000,
    restaurant,
    distanceKm: type === 'delivery' ? 3.4 : null,
    settings: active,
  });
  return Order.create({
    restaurantId: restaurant._id,
    type,
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    grandTotal: charges.grandTotal / 100,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    razorpayFee: 1100,
    razorpayTax: 168,
    status: 'out_for_delivery',
    deliveryAddress: { street: '1 Test Road', city: 'Bengaluru', coordinates: NEARBY_DROP },
    deliveryAssignment: type === 'delivery' ? { partnerId: partner._id, status: 'picked_up' } : undefined,
    ...fields,
  });
};

const INTERNAL = ['financials', 'razorpayFee', 'razorpayTax'];
const assertNoInternalMoney = (order, where) => {
  for (const key of INTERNAL) assert.equal(order?.[key], undefined, `${where} must not include ${key}`);
};

// ── Pricing #1: counter-paid takeaway owes the platform fee ───────────────────

test('takeaway paid at the counter, handed over → counter_platform_fee debit of ₹12.42 (once)', async () => {
  const order = await pricedOrder({
    type: 'takeaway',
    fields: { paymentMethod: 'cash', paymentChannel: 'counter', paymentStatus: 'pending', status: 'ready' },
  });
  await kitchenService.updateOrderStatus({
    orderId: order._id,
    currentStatus: 'ready',
    newStatus: 'delivered',
    actor: { role: 'chef' },
  });

  const entries = await RestaurantLedgerEntry.find({ orderId: order._id }).lean();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'counter_platform_fee');
  assert.equal(entries[0].direction, 'debit');
  assert.equal(entries[0].amountPaise, 1242, '₹12 fee + 3.5 % settlement charge on it');

  // Idempotent: a repeated hook writes nothing more.
  await ledgerService.onOrderDelivered(await Order.findById(order._id));
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id }), 1);

  const saved = await Order.findById(order._id).select('+financials').lean();
  assert.equal(saved.financials.restaurantNet, -1242);
});

test('COD delivery and an unpaid counter takeaway write no ledger row', async () => {
  const cod = await pricedOrder({ fields: { paymentMethod: 'cash', paymentChannel: 'cod', paymentStatus: 'paid' } });
  await ledgerService.onOrderDelivered(cod);
  const unpaid = await pricedOrder({
    type: 'takeaway',
    fields: { paymentMethod: 'cash', paymentChannel: 'counter', paymentStatus: 'pending' },
  });
  await ledgerService.onOrderDelivered(unpaid);
  assert.equal(await RestaurantLedgerEntry.countDocuments(), 0);
});

// ── Pricing #2 / Security #2, #3: no internal money in rider/chef responses ───

test('rider deliver response carries no financials / Razorpay fee', async () => {
  const order = await pricedOrder();
  const res = await srv.request('POST', `/api/partner/orders/${order._id}/deliver`, { headers: partnerHeaders(), body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertNoInternalMoney(res.body.data.order, 'partner deliver');
  assert.equal(await RestaurantLedgerEntry.countDocuments({ orderId: order._id }), 1, 'still credited');
});

test('chef status-update response carries no financials / Razorpay fee', async () => {
  const chef = await StaffMember.create({
    restaurantId: restaurant._id,
    staffCode: 'C01',
    name: 'Chef',
    role: 'chef',
    phone: '9000000001',
  });
  const headers = { authorization: `Bearer ${generateStaffToken(chef._id, 'chef', restaurant._id, 0)}` };
  // A delivery the restaurant runs itself (no Yulo rider) — the kitchen may close that one.
  const order = await pricedOrder({ fields: { deliveryAssignment: { partnerId: null, status: 'unassigned' } } });
  const res = await srv.request('PATCH', `/api/staff/${restaurant._id}/kitchen/orders/${order._id}/status`, {
    headers,
    body: { newStatus: 'delivered' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertNoInternalMoney(res.body.data.order, 'kitchen status');
  const saved = await Order.findById(order._id).select('+financials').lean();
  assert.ok(saved.financials, 'still frozen in the database');
});

test('the ledger hooks never put financials on the caller\'s document', async () => {
  const order = await pricedOrder({ fields: { status: 'delivered', deliveredAt: new Date() } });
  const doc = await Order.findById(order._id);
  await ledgerService.onOrderDelivered(doc);
  assert.equal(doc.financials, undefined);
  assert.equal(ledgerService.withoutInternalMoney({ a: 1, financials: {}, razorpayFee: 1 }).financials, undefined);
});

// ── Pricing #9: settled under the settings version that priced the order ──────

test('a settlement-charge change between placement and delivery does not apply to the order', async () => {
  const pricedUnder = await getActiveSettings();
  const order = await pricedOrder({ settings: pricedUnder, fields: { status: 'delivered', deliveredAt: new Date() } });
  await createVersion({ patch: { settlementChargePercent: 10 } }, admin._id);

  await ledgerService.onOrderDelivered(await Order.findById(order._id));
  const entry = await RestaurantLedgerEntry.findOne({ orderId: order._id }).lean();
  assert.equal(entry.breakdown.settlementCharge.percent, 3.5);
  assert.equal(entry.breakdown.settingsVersionId, String(pricedUnder._id));
});

// ── Pricing #4: checkout summary prices the picked address (and the tip) ──────

const located = (coordinates, extra = {}) => ({
  street: '1 Test Road',
  city: 'Bengaluru',
  pincode: '560001',
  location: { type: 'Point', coordinates },
  locationSource: 'map_pin',
  ...extra,
});

const seedCart = async () => {
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  const dish = await MenuItem.create({
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
    savedAddresses: [located(NEARBY_DROP, { isDefault: true, label: 'home' }), located(FAR_DROP, { label: 'work' })],
  });
  customerHeaders = { authorization: `Bearer ${generateTokens(customer._id, 'customer').accessToken}` };
  await Cart.create({
    userId: customer._id,
    restaurantId: restaurant._id,
    items: [{ menuItemId: dish._id, name: 'Thali', unitPrice: 300, mrpUnitPrice: 300, qty: 1, foodType: 'veg' }],
  });
};

test('checkout summary with addressId + tip = exactly what checkout then charges', async () => {
  await seedCart();
  const work = customer.savedAddresses.find((a) => a.label === 'work');

  const def = await srv.get('/api/checkout/summary', customerHeaders);
  const picked = await srv.get(`/api/checkout/summary?addressId=${work._id}&tip=20`, customerHeaders);
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(String(picked.body.data.address._id), String(work._id), 'returns the address it priced');
  assert.ok(
    picked.body.data.bill.charges.delivery.distanceKm > def.body.data.bill.charges.delivery.distanceKm,
    'priced against the farther, picked address'
  );
  assert.equal(picked.body.data.bill.charges.tip, 2000);

  const placed = await srv.request('POST', '/api/orders/checkout', {
    headers: customerHeaders,
    body: { paymentMethod: 'online', addressId: String(work._id), tip: 20 },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = await Order.findById(placed.body.data.orderId).lean();
  assert.deepEqual(order.charges, picked.body.data.bill.charges);
  assert.equal(order.paymentAmountPaise, picked.body.data.bill.charges.grandTotal);
});

test('checkout summary: unknown addressId → 404, malformed → 400', async () => {
  await seedCart();
  const unknown = await srv.get(`/api/checkout/summary?addressId=${restaurant._id}`, customerHeaders);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'ADDRESS_NOT_FOUND');
  const bad = await srv.get('/api/checkout/summary?addressId=nope', customerHeaders);
  assert.equal(bad.status, 400);
});

// ── Tip cap ──────────────────────────────────────────────────────────────────

test('a tip above ₹500 is refused (pricing engine, summary and checkout)', async () => {
  const settings = await getActiveSettings();
  assert.throws(
    () => computeCustomerCharges({ orderType: 'takeaway', foodSubtotalPaise: 100, restaurant, tipPaise: MAX_TIP_PAISE + 1, settings }),
    (e) => e.code === 'TIP_TOO_HIGH'
  );
  await seedCart();
  const summary = await srv.get('/api/checkout/summary?tip=501', customerHeaders);
  assert.equal(summary.status, 400);
  const placed = await srv.request('POST', '/api/orders/checkout', {
    headers: customerHeaders,
    body: { paymentMethod: 'online', tip: 30000 },
  });
  assert.equal(placed.status, 400);
  assert.equal(placed.body.code, 'TIP_TOO_HIGH');
  assert.equal(await Order.countDocuments(), 0);
});

// ── Pricing #5: versions don't undo each other ────────────────────────────────

test('a change saved today survives a change already scheduled for later', async () => {
  const tomorrow = new Date(Date.now() + DAY);
  await createVersion({ patch: { customerPlatformFee: 1500 }, effectiveFrom: tomorrow }, admin._id);
  const { reappliedTo } = await createVersion({ patch: { riderBasePay: 2500 } }, admin._id);
  assert.equal(reappliedTo.length, 1);

  const now = await getActiveSettings(new Date());
  assert.equal(now.riderBasePay, 2500);
  assert.equal(now.customerPlatformFee, 1200);

  const later = await getActiveSettings(new Date(Date.now() + 2 * DAY));
  assert.equal(later.riderBasePay, 2500, 'not reverted by the scheduled version');
  assert.equal(later.customerPlatformFee, 1500, 'the scheduled change still happens');
});

test('a change scheduled after another scheduled change builds on it', async () => {
  await createVersion({ patch: { riderBasePay: 2500 }, effectiveFrom: new Date(Date.now() + DAY) }, admin._id);
  await createVersion({ patch: { customerPlatformFee: 1500 }, effectiveFrom: new Date(Date.now() + 2 * DAY) }, admin._id);
  const at3 = await getActiveSettings(new Date(Date.now() + 3 * DAY));
  assert.equal(at3.riderBasePay, 2500);
  assert.equal(at3.customerPlatformFee, 1500);
});

test('a save is not merged onto another instance\'s stale cached settings', async () => {
  await getActiveSettings(); // warm this process's cache
  // Another instance saves directly (this process's cache is now stale).
  const current = await FinanceSettings.findOne().sort({ version: -1 }).lean();
  const { _id, version, createdAt, updatedAt, __v, ...rest } = current;
  await FinanceSettings.create({ ...rest, version: version + 1, riderBasePay: 3000, effectiveFrom: new Date() });

  await createVersion({ patch: { customerPlatformFee: 1500 } }, admin._id);
  __resetFinanceSettingsCache();
  const active = await getActiveSettings();
  assert.equal(active.riderBasePay, 3000, "the other instance's change is kept");
  assert.equal(active.customerPlatformFee, 1500);
});

// ── Pricing #7: patch doesn't inject the payout file format ───────────────────

test('a settings patch does not reset payoutBankFileFormat', () => {
  const parsed = financeSettingsPatchSchema.parse({ codEnabled: true });
  assert.deepEqual(parsed, { codEnabled: true });
});

// ── Admin GSTIN rule ──────────────────────────────────────────────────────────

test('admin store update: settings without gstNumber keeps the GSTIN; a numeric GSTIN is refused', async () => {
  const partial = await srv.request('PATCH', `/api/admin/stores/${restaurant._id}`, {
    headers: adminHeaders(),
    body: { settings: { serviceChargePercent: 5 } },
  });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  const after = await Restaurant.findById(restaurant._id).lean();
  assert.equal(after.settings.gstNumber, '29ABCDE1234F1Z5', 'GSTIN not wiped');
  assert.equal(after.settings.serviceChargePercent, 5);
  assert.equal(after.settings.panNumber, 'ABCDE1234F', 'other settings kept');

  const numeric = await srv.request('PATCH', `/api/admin/stores/${restaurant._id}`, {
    headers: adminHeaders(),
    body: { settings: { gstNumber: 123456789012345 } },
  });
  assert.equal(numeric.status, 400);

  const cleared = await srv.request('PATCH', `/api/admin/stores/${restaurant._id}`, {
    headers: adminHeaders(),
    body: { settings: { gstNumber: '' } },
  });
  assert.equal(cleared.status, 400, 'a GST-registered store cannot lose its GSTIN');
});
