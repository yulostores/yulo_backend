// B2 — Restaurant.gstRegistered through the owner and admin write paths, and every rate that
// used to come from env (cart platform fee & tax, commission, rider per-delivery pay) now
// following Finance Settings. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { createVersion, __resetFinanceSettingsCache, getActiveSettings } = await import(
  '../services/financeSettings.service.js'
);
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Cart } = await import('../models/Cart.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { generateTokens } = await import('../services/auth.service.js');
const cartService = await import('../services/cart.service.js');
const { buildOfferPayload } = await import('../services/deliveryAssignment.service.js');
const { ensurePayoutForPeriod } = await import('../services/payout.service.js');
const { getFinanceOverview } = await import('../services/finance.service.js');

let mongo;
let srv;
let owner;
let admin;
let restaurant;

const VALID_GSTIN = '27AAPFU0939F1ZV';

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'a@test.local', role: 'admin' });
  // Every field the store-settings form requires, so a save is judged only on the GST rules.
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    email: 'hello@spice.test',
    phone: '9876543210',
    address: { street: '12 Main Road', city: 'Pune', state: 'MH', pincode: '411001' },
    location: { type: 'Point', coordinates: [73.85, 18.52] },
    settings: { legalEntityType: 'Partnership', ownerName: 'Owner', panNumber: 'ABCDE1234F' },
    isActive: true,
    approvalStatus: 'active',
    delivery: { baseCharge: 30 },
  });
});

const ownerHeaders = () => ({ authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` });
const adminHeaders = () => ({ authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` });
const ownerPatch = (body) =>
  srv.request('PATCH', `/api/owner/${restaurant._id}/settings`, { headers: ownerHeaders(), body });
const adminPatch = (body) =>
  srv.request('PATCH', `/api/admin/stores/${restaurant._id}`, { headers: adminHeaders(), body });

// ── GST flag: owner ───────────────────────────────────────────────────────────

test('owner: new restaurants default to not GST-registered; the contract exposes the toggle', async () => {
  assert.equal(restaurant.gstRegistered, false);
  const req = await srv.get('/api/owner/settings-requirements', ownerHeaders());
  const fields = req.body.data.requirements.fields;
  const toggle = fields.find((f) => f.path === 'gstRegistered');
  assert.equal(toggle.type, 'toggle');
  assert.equal(toggle.section, 'tax');
  const gst = fields.find((f) => f.path === 'settings.gstNumber');
  assert.equal(gst.required, false, 'not statically required');
  assert.deepEqual(gst.requiredWhen.path, 'gstRegistered');
});

test('owner: turning GST registration on without a valid GSTIN is refused', async () => {
  const missing = await ownerPatch({ gstRegistered: true });
  assert.equal(missing.status, 400);
  assert.match(missing.body.details.fieldErrors['settings.gstNumber'], /required/);

  const malformed = await ownerPatch({ gstRegistered: true, settings: { gstNumber: '27AACR1234F1Z1' } });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.details.fieldErrors['settings.gstNumber'], /GSTIN/);

  assert.equal((await Restaurant.findById(restaurant._id).lean()).gstRegistered, false);
});

test('owner: GST registration with a valid GSTIN saves; multipart-style "true" strings work', async () => {
  const res = await ownerPatch({ gstRegistered: 'true', settings: { gstNumber: VALID_GSTIN } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = await Restaurant.findById(restaurant._id).lean();
  assert.equal(saved.gstRegistered, true);
  assert.equal(saved.settings.gstNumber, VALID_GSTIN);

  const bogus = await ownerPatch({ gstRegistered: 'yes' });
  assert.equal(bogus.status, 400);
});

test('owner: a non-registered restaurant with a legacy, non-standard GST number can still save', async () => {
  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'settings.gstNumber': 'OLD-123' } });
  const res = await ownerPatch({ phone: '9123456789' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

// ── GST flag: admin ───────────────────────────────────────────────────────────

test('admin: gstRegistered accepted with a valid GSTIN, refused without one', async () => {
  const refused = await adminPatch({ gstRegistered: true });
  assert.equal(refused.status, 400);

  const notBoolean = await adminPatch({ gstRegistered: 'true' });
  assert.equal(notBoolean.status, 400);

  await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'settings.gstNumber': VALID_GSTIN } });
  const ok = await adminPatch({ gstRegistered: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await Restaurant.findById(restaurant._id).lean()).gstRegistered, true);

  const off = await adminPatch({ gstRegistered: false });
  assert.equal(off.status, 200);
});

// ── Rates now come from Finance Settings ──────────────────────────────────────

test('cart bill: platform fee and tax rate follow Finance Settings', async () => {
  const customer = await User.create({ name: 'C', phone: '9000000002', role: 'customer' });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  const dish = await MenuItem.create({
    restaurantId: restaurant._id,
    categoryId: category._id,
    name: 'Thali',
    foodType: 'veg',
    sellingPrice: 300,
  });
  const cart = await Cart.create({
    userId: customer._id,
    restaurantId: restaurant._id,
    items: [{ menuItemId: dish._id, name: 'Thali', unitPrice: 300, qty: 1, foodType: 'veg' }],
  });

  const priced = { delivery: {}, location: restaurant.location, gstRegistered: true };
  const defaults = await cartService.computeBill(cart.toObject(), priced);
  assert.equal(defaults.platformFee, 12, '₹12 from customerPlatformFee 1200 paise');
  assert.equal(defaults.tax, 15, '5 % food GST');

  await createVersion({ patch: { customerPlatformFee: 1500, foodGstPercent: 12 } }, admin._id);
  const changed = await cartService.computeBill(cart.toObject(), priced);
  assert.equal(changed.platformFee, 15);
  assert.equal(changed.tax, 36);
});

test('rider per-delivery pay (offer fare, payouts) follows riderBasePay', async () => {
  const partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi' });
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    paymentMethod: 'online',
    deliveryAssignment: {
      partnerId: partner._id,
      status: 'delivered',
      // Payouts sum each delivery's frozen pay (B10); this one earned the base rate.
      earningsBreakdown: { basePay: 20, distancePay: 0, tip: 0, computedAt: new Date() },
    },
    deliveredAt: new Date(),
  });

  const offer = await buildOfferPayload(order.toObject(), partner.toObject());
  assert.equal(offer.fare, 20, '₹20 from riderBasePay 2000 paise');

  const payout = await ensurePayoutForPeriod(partner._id, 'weekly');
  assert.equal(payout.perDeliveryRate, 20);
  assert.equal(payout.grossEarnings, 20);

  await createVersion({ patch: { riderBasePay: 3500 } }, admin._id);
  assert.equal((await buildOfferPayload(order.toObject(), partner.toObject())).fare, 35);
});

test('finance analytics "commission" uses the settlement charge rate, not the removed 15 %', async () => {
  await Bill.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    orderId: restaurant._id,
    subtotal: 1000,
    grandTotal: 1000,
    status: 'paid',
    paidAt: new Date(),
  });
  const overview = await getFinanceOverview();
  assert.equal(overview.grossRevenue, 1000);
  assert.equal(overview.commissionRevenue, 1000 * ((await getActiveSettings()).settlementChargePercent / 100));
  assert.equal(overview.commissionRevenue, 35);
});
