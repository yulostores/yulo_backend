// A QR-menu guest (no account) fills in name, gender, mobile and date of birth before paying the
// table's bill, and gets the partner coupons that bill earns — on the paying device straight away,
// and in the customer account with that mobile number. Fake Razorpay, in-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { checkoutSignature, createFakeRazorpay, seedBasics, useFakeGatewayEnv } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const issue = await import('../services/couponIssue.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: User } = await import('../models/User.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');

let mongo;
let srv;
let fake;
let seed;
let table;
let session;
const oid = () => new mongoose.Types.ObjectId();

const DETAILS = { name: 'Ravi Kumar', gender: 'male', phone: '+91 98111 22334', dateOfBirth: '1995-06-15' };

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Seller.init(), Coupon.init(), SellerSubscription.init(), User.init()]);
  srv = await startTestServer({ withSocket: true });
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await mongo.clear();
  __resetCouponSettingsCache();
  await seedCouponData({ apply: true, log: () => {} });
  seed = await seedBasics(); // restaurant at [77.59, 12.97]

  // One active salon next door with stock and an approved offer.
  const salon = await CouponCategory.findOneAndUpdate({ key: 'salon' }, { $set: { enabled: true } }, { new: true }).lean();
  await CouponCategory.updateMany({ key: { $ne: 'salon' } }, { $set: { enabled: false } });
  const sellerId = oid();
  await Seller.collection.insertOne({
    _id: sellerId,
    businessName: 'Glow Salon',
    status: 'active',
    categoryId: salon._id,
    location: { type: 'Point', coordinates: [77.591, 12.971] },
    address: { line1: '1 MG Road', city: 'Bengaluru' },
  });
  await CouponOffer.collection.insertOne({ sellerId, categoryId: salon._id, status: 'approved', title: '20% off any haircut', terms: 'One per visit' });
  await SellerSubscription.collection.insertOne({
    sellerId,
    status: 'active',
    activatedAt: new Date(),
    allocated: 10,
    issued: 0,
    remaining: 10,
    planSnapshot: { key: 'basic', name: 'Basic', totalPaise: 590000 },
    payment: { method: 'manual' },
  });

  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T9' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price: 600, quantity: 1 }],
    subtotal: 600,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
});

const base = () => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill`;

const payOnline = async (couponDetails, paymentId = 'pay_guest_1') => {
  const start = await srv.request('POST', `${base()}/pay`, { body: couponDetails ? { couponDetails } : {} });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const { razorpayOrder, couponToken } = start.body.data;
  fake.addPayment({ id: paymentId, order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  const verify = await srv.request('POST', `${base()}/verify`, {
    body: { razorpay_payment_id: paymentId, razorpay_order_id: razorpayOrder.id, razorpay_signature: checkoutSignature(razorpayOrder.id, paymentId) },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  await issue.settleScheduledIssues();
  return couponToken;
};

test('guest gives details → coupons issued to that mobile number, shown on the paying device', async () => {
  const token = await payOnline(DETAILS);
  assert.ok(token && token.length >= 20, 'the paying device gets a token');

  const user = await User.findOne({ phone: '9811122334' }).lean();
  assert.ok(user, 'a customer account for the number');
  assert.equal(user.role, 'customer');
  assert.equal(user.name, 'Ravi Kumar');
  assert.equal(user.gender, 'male');
  assert.equal(user.phoneVerifiedAt, null, 'not verified until they sign in with an OTP');

  const coupons = await Coupon.find({ 'source.type': 'bill' }).lean();
  assert.equal(coupons.length, 1);
  assert.equal(String(coupons[0].customerId), String(user._id));
  assert.equal(coupons[0].customerSnapshot.gender, 'male');

  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.customerName, 'Ravi Kumar');
  assert.equal(bill.customerPhone, '9811122334');
  assert.equal(bill.couponClaim.tokenHash, undefined, 'the token hash is never read out by default');

  const res = await srv.get(`${base()}/coupons?token=${encodeURIComponent(token)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.paid, true);
  assert.equal(res.body.data.phoneLast4, '2334');
  assert.equal(res.body.data.coupons.length, 1);
  assert.equal(res.body.data.coupons[0].title, '20% off any haircut');
  assert.equal(res.body.data.coupons[0].seller.name, 'Glow Salon');
  assert.match(res.body.data.coupons[0].code, /\w+/);

  // Without the token — or with a wrong one — nobody else at the table sees the codes.
  assert.equal((await srv.get(`${base()}/coupons`)).status, 404);
  assert.equal((await srv.get(`${base()}/coupons?token=${'x'.repeat(32)}`)).status, 404);
});

test('skipping the form: payment works, no coupons, no account created', async () => {
  const token = await payOnline(null);
  assert.equal(token, null);
  assert.equal(await Coupon.countDocuments(), 0);
  assert.equal(await User.countDocuments({ phone: '9811122334' }), 0);
  assert.equal((await Bill.findOne({ tableSessionId: session._id }).lean()).status, 'paid');
});

test('an existing customer keeps their own profile; the coupons join their account', async () => {
  const existing = await User.create({ phone: '9811122334', role: 'customer', name: 'Ravi K', gender: null, dateOfBirth: null, phoneVerifiedAt: new Date() });
  await payOnline(DETAILS);
  const after = await User.findById(existing._id).lean();
  assert.equal(after.name, 'Ravi K', 'name not overwritten');
  assert.equal(after.gender, 'male', 'missing gender filled');
  assert.equal(new Date(after.dateOfBirth).toISOString().slice(0, 10), '1995-06-15');
  assert.equal(await User.countDocuments({ phone: '9811122334' }), 1);
  const coupon = await Coupon.findOne().lean();
  assert.equal(String(coupon.customerId), String(existing._id));
});

test("a restaurant owner's number never gets coupons", async () => {
  await User.updateOne({ _id: seed.owner._id }, { $set: { phone: '9811122334' } });
  await payOnline(DETAILS);
  assert.equal(await Coupon.countDocuments(), 0);
});

test('bad details are refused before any payment starts', async () => {
  for (const bad of [
    { ...DETAILS, phone: '12345' },
    { ...DETAILS, name: 'R' },
    { ...DETAILS, gender: 'x' },
    { ...DETAILS, dateOfBirth: '2024-01-01' }, // too young
    { ...DETAILS, dateOfBirth: '1995-02-30' },
  ]) {
    const res = await srv.request('POST', `${base()}/pay`, { body: { couponDetails: bad } });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.ok(!bill?.paymentIntentId, 'no Razorpay order was created');
});
