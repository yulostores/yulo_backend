// The admin finance overview's Yulo money from the ledger (revenue, Razorpay fees, GST split)
// and the refunds list's source filter + restaurant names. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const financeService = await import('../services/finance.service.js');
const { generateTokens } = await import('../services/auth.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');

let mongo;
let srv;
let admin;
let restaurant;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [77.59, 12.97] } });
});

const now = () => new Date();

test('overview: Yulo revenue, Razorpay fees and the GST split come from the ledger (PDF cases 1 and 4)', async () => {
  const orderId = new mongoose.Types.ObjectId();
  const billId = new mongoose.Types.ObjectId();
  // Case 1 — delivery paid online: ₹357 = 315 food (15 GST) + 30 delivery (4.58 GST) + 12 fee (1.83 GST).
  await Order.collection.insertOne({
    _id: orderId,
    restaurantId: restaurant._id,
    charges: { food: { gst: 1500 }, delivery: { gst: 458, total: 3000 }, platformFee: { gst: 183, total: 1200 }, grandTotal: 35700 },
  });
  // Case 4 — dine-in paid at the counter: only the ₹12 platform fee + 3.5 % of it reach Yulo.
  await Bill.collection.insertOne({ _id: billId, restaurantId: restaurant._id, charges: { food: { gst: 1500 }, platformFee: { gst: 183, total: 1200 } } });
  await RestaurantLedgerEntry.collection.insertMany([
    {
      restaurantId: restaurant._id,
      type: 'order_earning',
      direction: 'credit',
      amountPaise: 30250,
      orderId,
      eligibleAt: now(),
      breakdown: {
        customerPaid: 35700,
        yuloMoney: { platformFee: 1200, deliveryCharge: 3000 },
        settlementCharge: { base: 1059, gst: 191, total: 1250 },
        restaurantBorneDelivery: 0,
        gateway: { fee: 964, tax: 174, total: 1138 },
        yuloSettlementMargin: 112,
      },
    },
    {
      restaurantId: restaurant._id,
      type: 'counter_platform_fee',
      direction: 'debit',
      amountPaise: 1242,
      billId,
      eligibleAt: now(),
      breakdown: {
        customerPaid: 0,
        yuloMoney: { platformFee: 1200, deliveryCharge: 0 },
        settlementCharge: { base: 36, gst: 6, total: 42 },
        gateway: { fee: 0, tax: 0, total: 0 },
        yuloSettlementMargin: 42,
      },
    },
  ]);

  const { yulo } = await financeService.getFinanceOverview();
  assert.deepEqual(
    {
      yuloRevenue: yulo.yuloRevenue,
      platformFees: yulo.platformFees,
      deliveryCharges: yulo.deliveryCharges,
      settlementCharges: yulo.settlementCharges,
      settlementMargin: yulo.settlementMargin,
      gatewayFees: yulo.gatewayFees,
      gatewayGst: yulo.gatewayGst,
    },
    {
      yuloRevenue: 55.54, // 24 platform fees + 30 delivery + 1.54 margin
      platformFees: 24,
      deliveryCharges: 30,
      settlementCharges: 12.92,
      settlementMargin: 1.54,
      gatewayFees: 11.38,
      gatewayGst: 1.74,
    }
  );
  assert.deepEqual(yulo.gst, {
    foodRestaurantLiability: 15, // the counter bill's food GST never passed through Yulo
    yuloLiability: 10.21,
    yuloOnPlatformFees: 3.66,
    yuloOnDelivery: 4.58,
    yuloOnSettlementCharges: 1.97,
  });
});

test('refunds list: filter by source, each row names its restaurant', async () => {
  const pending = (extra) => ({ restaurantId: restaurant._id, razorpayPaymentId: `pay_${Math.random().toString(36).slice(2)}`, refund: { status: 'failed', amountPaise: 1000 }, ...extra });
  await Order.collection.insertOne(pending({ status: 'cancelled', updatedAt: now() }));
  await Bill.collection.insertOne(pending({ status: 'paid', updatedAt: now() }));
  await StrayPayment.collection.insertOne(pending({ kind: 'duplicate_payment', amountPaise: 1000, updatedAt: now() }));
  const headers = { authorization: `Bearer ${generateTokens(admin._id, 'admin').accessToken}` };

  const all = await srv.get('/api/admin/finance/refunds', headers);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.data.total, 3);
  assert.ok(all.body.data.refunds.every((r) => r.restaurantName === 'Spice Route'));

  for (const [source, expected] of [['bill', 'bill'], ['stray', 'stray_payment'], ['order', 'order']]) {
    const res = await srv.get(`/api/admin/finance/refunds?source=${source}`, headers);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.refunds.map((r) => r.source), [expected]);
    assert.equal(res.body.data.total, 1);
  }
  assert.equal((await srv.get('/api/admin/finance/refunds?source=nope', headers)).status, 400);
});
