// Checkout's cooking request text — `cookingInstructions` says what the "Cooking requests"
// toggle is about, is saved on the order, and reaches the restaurant. Optional: older app
// builds never send it and must keep working exactly as before.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Order } = await import('../models/Order.js');
const { generateTokens } = await import('../services/auth.service.js');

const RESTAURANT_AT = [77.59, 12.97];
const DROP = [77.599, 12.97];

let mongo;
let srv;
let customer;
let dish;

before(async () => {
  mongo = await startMemoryMongo();
  __setRazorpayForTests(createFakeRazorpay());
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
  const owner = await User.create({ name: 'Owner', email: 'owner@test.local', role: 'restaurant_owner' });
  const user = await User.create({
    name: 'Asha',
    phone: '9876543210',
    role: 'customer',
    savedAddresses: [
      {
        street: '22 Lake Road',
        city: 'Bengaluru',
        pincode: '560001',
        location: { type: 'Point', coordinates: DROP },
        locationSource: 'map_pin',
        isDefault: true,
      },
    ],
  });
  customer = { authorization: `Bearer ${generateTokens(user._id, 'customer').accessToken}` };
  const restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    delivery: { radiusKm: 10 },
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Thalis' });
  dish = await MenuItem.create({
    restaurantId: restaurant._id,
    categoryId: category._id,
    name: 'Thali',
    foodType: 'veg',
    sellingPrice: 300,
  });
});

const checkout = async (extra) => {
  const added = await srv.request('POST', '/api/cart/items', {
    headers: customer,
    body: { menuItemId: String(dish._id), qty: 1 },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return srv.request('POST', '/api/orders/checkout', {
    headers: customer,
    body: { paymentMethod: 'online', ...extra },
  });
};

const placedOrder = async (res) => {
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
  return Order.findById(res.body.data.orderId).lean();
};

test('the cooking request text is saved on the order, trimmed', async () => {
  const order = await placedOrder(
    await checkout({ cookingRequests: true, cookingInstructions: '  Less spicy, no onion  ' }),
  );
  assert.equal(order.cookingRequests, true);
  assert.equal(order.cookingInstructions, 'Less spicy, no onion');
});

test('text sent without the toggle still marks the order as having a cooking request', async () => {
  const order = await placedOrder(await checkout({ cookingInstructions: 'Extra crispy' }));
  assert.equal(order.cookingRequests, true);
  assert.equal(order.cookingInstructions, 'Extra crispy');
});

test('an app that sends no text places the order exactly as before', async () => {
  const withToggle = await placedOrder(await checkout({ cookingRequests: true }));
  assert.equal(withToggle.cookingRequests, true);
  assert.equal(withToggle.cookingInstructions, '');

  await Order.deleteMany({});
  const plain = await placedOrder(await checkout({}));
  assert.equal(plain.cookingRequests, false);
  assert.equal(plain.cookingInstructions, '');
});

test('text over 300 characters is refused and no order is created', async () => {
  const res = await checkout({ cookingRequests: true, cookingInstructions: 'x'.repeat(301) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(await Order.countDocuments(), 0);
});
