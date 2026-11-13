// CB6 — the issue engine: a paid food order / dine-in bill earns partner coupons (one per enabled
// category up to the cap, nearest seller with stock first), voids on a full refund, the customer's
// gender / date of birth, and My Coupons. Fake Razorpay, in-memory MongoDB. Every payment goes
// through the real HTTP verify / webhook / mark-paid endpoints.

import test, { after, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  webhookSignature,
  paymentCapturedEvent,
  seedBasics,
  createPendingOnlineOrder,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { makeCategory, makeCompleteSeller } = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { __resetCouponSettingsCache, createCouponSettingsVersion } = await import('../services/couponSettings.service.js');
const issue = await import('../services/couponIssue.service.js');
const { generateTokens, generateStaffToken } = await import('../services/auth.service.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: User } = await import('../models/User.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: CouponOffer } = await import('../models/CouponOffer.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: IdempotencyKey } = await import('../models/IdempotencyKey.js');

let mongo;
let srv;
let fake;
let seed;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([
    Seller.init(),
    Coupon.init(),
    SellerSubscription.init(),
    WebhookEvent.init(),
    IdempotencyKey.init(),
    RestaurantLedgerEntry.init(),
  ]);
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  // clear() drops documents, not indexes — but make sure the geo and unique indexes exist.
  await Promise.all([Seller.init(), Coupon.init()]);
  __resetFinanceSettingsCache();
  __resetCouponSettingsCache();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics(); // restaurant at [77.59, 12.97]
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RESTAURANT = [77.59, 12.97];
// Roughly 1.1 km per 0.01° of longitude here.
const east = (km) => [RESTAURANT[0] + km / 108.5, RESTAURANT[1]];

const customerHeaders = (user = seed.customer) => ({ authorization: `Bearer ${generateTokens(user._id, 'customer').accessToken}` });

const settings = (patch) => createCouponSettingsVersion({ patch, note: 'test' }, new mongoose.Types.ObjectId()).then(() => __resetCouponSettingsCache());

let phoneN = 0;
let catN = 0;
const category = (over = {}) => {
  catN += 1;
  return makeCategory({ key: `cat-${catN}`, name: `Category ${catN}`, enabled: true, sortOrder: catN, ...over });
};

/** An approved seller with an approved offer and `stock` coupons of an active plan. */
const partner = async ({ cat, at = east(1), stock = 10, issued = 0, offer = {}, status = 'active', name } = {}) => {
  phoneN += 1;
  const { seller } = await makeCompleteSeller({ status, categoryId: cat._id, phone: `95${String(phoneN).padStart(8, '0')}` });
  await Seller.updateOne(
    { _id: seller._id },
    { $set: { location: { type: 'Point', coordinates: at }, ...(name ? { businessName: name } : {}) } }
  );
  const sub = await SellerSubscription.create({
    sellerId: seller._id,
    planSnapshot: {
      planId: new mongoose.Types.ObjectId(),
      key: 'basic',
      name: 'Basic',
      basePricePaise: 500_000,
      gstPercent: 18,
      gstPaise: 90_000,
      totalPaise: 590_000,
      couponAllocation: stock + issued,
      complimentaryCount: 5,
    },
    status: stock > 0 ? 'active' : 'exhausted',
    payment: { method: 'manual', manual: { mode: 'neft', reference: `REF${phoneN}` } },
    allocated: stock + issued,
    issued,
    remaining: stock,
    activatedAt: new Date(Date.now() - 60_000),
  });
  const approved = await CouponOffer.create({
    sellerId: seller._id,
    categoryId: cat._id,
    title: `20% off at seller ${phoneN}`,
    terms: 'One per visit',
    status: 'approved',
    ...offer,
  });
  return { seller: await Seller.findById(seller._id).lean(), sub, offer: approved };
};

const stockOf = async (sub) => SellerSubscription.findById(sub._id).lean();
const couponsFor = (sourceType, id) => Coupon.find({ 'source.type': sourceType, 'source.id': id, kind: 'customer' }).lean();

let payN = 0;
/** A pending online order paid through POST /api/orders/:id/payment/verify. */
const payOrder = async (over = {}, user = seed.customer) => {
  const order = await createPendingOnlineOrder({ ...seed, customer: user }, over);
  const paymentId = `pay_issue_${(payN += 1)}`;
  const payment = fake.addPayment({ id: paymentId, order_id: order.paymentIntentId, amount: order.paymentAmountPaise });
  const res = await srv.request('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: customerHeaders(user),
    body: { razorpay_payment_id: paymentId, razorpay_order_id: order.paymentIntentId, razorpay_signature: checkoutSignature(order.paymentIntentId, paymentId) },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await issue.settleScheduledIssues();
  return { order, payment };
};

const webhook = async (payment, eventId) => {
  const raw = JSON.stringify(paymentCapturedEvent(payment));
  const res = await srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': eventId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

// ── Issuing ───────────────────────────────────────────────────────────────────

test('a paid order earns one coupon per enabled category, in sortOrder, up to the cap', async () => {
  const cats = [];
  for (let i = 0; i < 4; i += 1) cats.push(await category());
  const partners = [];
  for (const cat of cats) partners.push(await partner({ cat }));

  const { order } = await payOrder();
  const coupons = await couponsFor('order', order._id);
  assert.equal(coupons.length, 3, 'perOrderCap defaults to 3');
  assert.deepEqual(
    coupons.map((c) => String(c.categoryId)).sort(),
    cats.slice(0, 3).map((c) => String(c._id)).sort(),
    'the first three categories by sortOrder'
  );
  for (const c of coupons) {
    assert.equal(c.status, 'issued');
    assert.equal(c.kind, 'customer');
    assert.equal(String(c.customerId), String(seed.customer._id));
    assert.match(c.code, /^[A-Z2-9]{10}$/);
    assert.equal(c.issueKey, `order:${order._id}:${c.categoryId}`);
    const days = (c.expiresAt - c.issuedAt) / 86_400_000;
    assert.equal(days, 30, 'default validity');
    assert.ok(c.offerSnapshot.title.startsWith('20% off'));
  }
  for (const [i, p] of partners.entries()) {
    const s = await stockOf(p.sub);
    assert.equal(s.remaining, i < 3 ? 9 : 10, `stock of category ${i + 1}`);
    assert.equal(s.issued, i < 3 ? 1 : 0);
  }

  await settings({ perOrderCap: 1 });
  const { order: second } = await payOrder();
  assert.equal((await couponsFor('order', second._id)).length, 1, 'cap changed in settings');
});

test('disabled category, no stock, no approved offer, suspended seller → nothing from that category', async () => {
  const off = await category({ enabled: false });
  await partner({ cat: off });
  const empty = await category();
  await partner({ cat: empty, stock: 0, issued: 250 });
  const draftOnly = await category();
  await partner({ cat: draftOnly, offer: { status: 'pending_review' } });
  const suspended = await category();
  await partner({ cat: suspended, status: 'suspended' });
  const good = await category();
  const p = await partner({ cat: good });

  const { order } = await payOrder();
  const coupons = await couponsFor('order', order._id);
  assert.equal(coupons.length, 1);
  assert.equal(String(coupons[0].sellerId), String(p.seller._id));
});

test('the offer validity overrides the default; the offer snapshot survives a later edit', async () => {
  const cat = await category();
  const p = await partner({ cat, offer: { validityDays: 7 } });
  const { order } = await payOrder();
  const [c] = await couponsFor('order', order._id);
  assert.equal((c.expiresAt - c.issuedAt) / 86_400_000, 7);

  await CouponOffer.updateOne({ _id: p.offer._id }, { $set: { title: 'Changed', terms: 'New terms' } });
  const res = await srv.get(`/api/users/me/coupons/${c._id}`, customerHeaders());
  assert.equal(res.body.data.coupon.title, p.offer.title, 'the customer keeps the wording they were given');
  assert.equal(res.body.data.coupon.terms, 'One per visit');
});

test('seller choice: out-of-radius ignored, nearest wins, a tie goes to the one that issued fewer', async () => {
  const cat = await category();
  const far = await partner({ cat, at: east(15) }); // beyond the 10 km default
  const near = await partner({ cat, at: east(2) });
  const nearer = await partner({ cat, at: east(1) });

  const { order } = await payOrder();
  const [first] = await couponsFor('order', order._id);
  assert.equal(String(first.sellerId), String(nearer.seller._id), 'nearest first');
  assert.equal((await stockOf(far.sub)).issued, 0, 'out of radius never chosen');
  assert.equal((await stockOf(near.sub)).issued, 0);

  // Two sellers at the same spot: the one that has issued fewer goes first.
  const cat2 = await category();
  const spot = east(3);
  const busy = await partner({ cat: cat2, at: spot, issued: 40 });
  const quiet = await partner({ cat: cat2, at: spot, issued: 5 });
  await CouponCategory.updateOne({ _id: cat._id }, { $set: { enabled: false } });
  const { order: second } = await payOrder();
  const [c] = await couponsFor('order', second._id);
  assert.equal(String(c.sellerId), String(quiet.seller._id));
  assert.equal((await stockOf(busy.sub)).issued, 40);

  // Out of radius when the admin narrows it.
  await settings({ radiusKm: 2 });
  const { order: third } = await payOrder();
  assert.equal((await couponsFor('order', third._id)).length, 0, 'the 3 km pair is now out of range');
});

test('the nearest seller out of stock → the next nearest; several approved offers take turns', async () => {
  const cat = await category();
  await partner({ cat, at: east(1), stock: 0, issued: 250 });
  const next = await partner({ cat, at: east(4) });
  const second = await CouponOffer.create({ sellerId: next.seller._id, categoryId: cat._id, title: 'Free wash', status: 'approved' });

  const offersUsed = [];
  for (let i = 0; i < 4; i += 1) {
    const { order } = await payOrder();
    const [c] = await couponsFor('order', order._id);
    assert.equal(String(c.sellerId), String(next.seller._id));
    offersUsed.push(String(c.offerId));
  }
  assert.equal(offersUsed.filter((o) => o === String(next.offer._id)).length, 2);
  assert.equal(offersUsed.filter((o) => o === String(second._id)).length, 2);
});

test('nothing for: a guest, an order with no customer, a counter/COD order, an order below the minimum', async () => {
  const cat = await category();
  const p = await partner({ cat });

  // A guest session can't check out at all; even a paid order somehow tied to one issues nothing.
  const guest = await User.create({ role: 'guest' });
  const guestOrder = await createPendingOnlineOrder({ ...seed, customer: guest }, { paymentStatus: 'paid', razorpayPaymentId: 'pay_guest' });
  assert.deepEqual(await issue.issueForPayment({ sourceType: 'order', sourceId: guestOrder._id }), [], 'guest');

  // No customer account on the order at all (e.g. staff-placed) — paid through the webhook.
  const anon = await createPendingOnlineOrder(seed, { userId: null });
  await webhook(fake.addPayment({ id: 'pay_anon', order_id: anon.paymentIntentId, amount: anon.paymentAmountPaise }), 'evt_anon');
  await issue.settleScheduledIssues();
  assert.equal((await Order.findById(anon._id).lean()).paymentStatus, 'paid');
  assert.equal((await couponsFor('order', anon._id)).length, 0, 'no customerId');

  // A cash-on-delivery order marked paid never runs the engine, and asking directly does nothing.
  const cod = await createPendingOnlineOrder(seed, { paymentMethod: 'cash', paymentChannel: 'cod', paymentStatus: 'paid' });
  assert.deepEqual(await issue.issueForPayment({ sourceType: 'order', sourceId: cod._id }), []);

  await settings({ minOrderValuePaise: 40_000 }); // ₹400 > the ₹357 order
  const { order: small } = await payOrder();
  assert.equal((await couponsFor('order', small._id)).length, 0, 'below the minimum');

  await settings({ minOrderValuePaise: 35_700 }); // exactly the order value → issues
  const { order: equal } = await payOrder();
  assert.equal((await couponsFor('order', equal._id)).length, 1, 'at the minimum');
  assert.equal((await stockOf(p.sub)).issued, 1, 'stock taken only for the one that issued');
});

test('webhook and verify on the same payment (in either order, or at once) → one coupon per category, stock taken once', async () => {
  const cats = [await category(), await category()];
  const subs = [];
  for (const cat of cats) subs.push((await partner({ cat })).sub);

  // verify, then the webhook
  const { order, payment } = await payOrder();
  await webhook(payment, 'evt_dup_1');
  await issue.settleScheduledIssues();
  assert.equal((await couponsFor('order', order._id)).length, 2);

  // webhook first, then verify, and both at once with direct calls racing.
  const second = await createPendingOnlineOrder(seed);
  const p2 = fake.addPayment({ id: 'pay_race', order_id: second.paymentIntentId, amount: second.paymentAmountPaise });
  await Promise.all([
    webhook(p2, 'evt_dup_2'),
    srv.request('POST', `/api/orders/${second._id}/payment/verify`, {
      headers: customerHeaders(),
      body: { razorpay_payment_id: 'pay_race', razorpay_order_id: second.paymentIntentId, razorpay_signature: checkoutSignature(second.paymentIntentId, 'pay_race') },
    }),
  ]);
  await Promise.all(Array.from({ length: 5 }, () => issue.issueForPayment({ sourceType: 'order', sourceId: second._id })));
  await issue.settleScheduledIssues();
  assert.equal((await couponsFor('order', second._id)).length, 2);

  for (const sub of subs) {
    const s = await stockOf(sub);
    assert.equal(s.issued, 2, 'one per paid order, never more');
    assert.equal(s.remaining, 8);
  }
});

test('a failing issue never fails the payment', async () => {
  const cat = await category();
  await partner({ cat });
  const find = mock.method(CouponCategory, 'find', () => {
    throw new Error('boom');
  });
  try {
    const { order } = await payOrder();
    const saved = await Order.findById(order._id).lean();
    assert.equal(saved.paymentStatus, 'paid', 'the payment is recorded');
    assert.equal((await couponsFor('order', order._id)).length, 0);
  } finally {
    find.mock.restore();
  }
  // And a crash mid-category gives the stock back.
  const create = mock.method(Coupon, 'create', async () => {
    throw new Error('disk full');
  });
  try {
    const cat2 = await category();
    const p2 = await partner({ cat: cat2 });
    await CouponCategory.updateOne({ _id: cat._id }, { $set: { enabled: false } });
    const { order } = await payOrder();
    assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'paid');
    assert.equal((await stockOf(p2.sub)).remaining, 10, 'stock returned');
    assert.equal((await stockOf(p2.sub)).issued, 0);
  } finally {
    create.mock.restore();
  }
});

// ── Dine-in bills ─────────────────────────────────────────────────────────────

let table;
let session;
const seatAndServe = async () => {
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T9' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id, guestName: 'Asha', guestPhone: '9876543210' });
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    userId: seed.customer._id, // a signed-in customer ordering from the table QR
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
};
const billBase = () => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill`;

test('a bill paid online issues; the payment poll shows the count, ids only to the bill\'s customer', async () => {
  const cat = await category();
  await partner({ cat });
  await seatAndServe();
  const pay = await srv.request('POST', `${billBase()}/pay`);
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  const { razorpayOrder } = pay.body.data;
  assert.ok(razorpayOrder, JSON.stringify(pay.body));
  fake.addPayment({ id: 'pay_bill', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  const res = await srv.request('POST', `${billBase()}/verify`, {
    body: { razorpay_payment_id: 'pay_bill', razorpay_order_id: razorpayOrder.id, razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_bill') },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await issue.settleScheduledIssues();

  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  const coupons = await couponsFor('bill', bill._id);
  assert.equal(coupons.length, 1);
  assert.equal(String(coupons[0].customerId), String(seed.customer._id));

  const anonymous = await srv.get(`${billBase()}/payment?razorpayOrderId=${razorpayOrder.id}`);
  assert.deepEqual(anonymous.body.data.bill.couponsEarned, { count: 1, ids: [] }, 'a stranger at the table sees no ids');
  const owner = await srv.get(`${billBase()}/payment?razorpayOrderId=${razorpayOrder.id}`, customerHeaders());
  assert.equal(owner.body.data.bill.couponsEarned.count, 1);
  assert.deepEqual(owner.body.data.bill.couponsEarned.ids, [String(coupons[0]._id)]);
});

test('a bill paid in cash at the counter issues nothing', async () => {
  const cat = await category();
  const p = await partner({ cat });
  await seatAndServe();
  const waiter = await StaffMember.create({ restaurantId: seed.restaurant._id, staffCode: 'W09', name: 'Ravi', role: 'waiter', phone: '9000000088' });
  const headers = { authorization: `Bearer ${generateStaffToken(waiter._id, 'waiter', seed.restaurant._id, 0)}` };
  await srv.get(`/api/staff/${seed.restaurant._id}/waiter/sessions/${session._id}/bill`, headers);
  const res = await srv.request('POST', `/api/staff/${seed.restaurant._id}/waiter/sessions/${session._id}/bill/mark-paid`, { headers, body: { method: 'cash' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await issue.settleScheduledIssues();
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  assert.equal(bill.paymentChannel, 'counter');
  assert.equal((await couponsFor('bill', bill._id)).length, 0);
  assert.equal((await stockOf(p.sub)).issued, 0);
});

// ── Voids ─────────────────────────────────────────────────────────────────────

test('a full refund voids the unused coupons and returns their stock; a redeemed one stays redeemed', async () => {
  const cats = [await category(), await category()];
  const subs = [];
  for (const cat of cats) subs.push((await partner({ cat })).sub);
  const { order } = await payOrder();
  const coupons = await couponsFor('order', order._id);
  assert.equal(coupons.length, 2);
  const redeemed = coupons.find((c) => String(c.categoryId) === String(cats[0]._id));
  await Coupon.updateOne({ _id: redeemed._id }, { $set: { status: 'redeemed', redeemedAt: new Date() } });

  // The customer cancels before the restaurant accepts → full refund.
  const res = await srv.request('POST', `/api/orders/${order._id}/cancel`, { headers: customerHeaders(), body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fake.calls.refund.length, 1);

  const after = await couponsFor('order', order._id);
  const byCat = new Map(after.map((c) => [String(c.categoryId), c]));
  assert.equal(byCat.get(String(cats[0]._id)).status, 'redeemed', 'redeemed stays redeemed');
  const voided = byCat.get(String(cats[1]._id));
  assert.equal(voided.status, 'void', 'voided as soon as the refund is under way');
  assert.ok(voided.voidedAt);
  assert.equal((await stockOf(subs[0])).issued, 1, 'the redeemed coupon keeps its stock');
  assert.equal((await stockOf(subs[1])).issued, 0, 'the voided one returns it');
  assert.equal((await stockOf(subs[1])).remaining, 10);

  // Razorpay later confirms the refund: voiding again changes nothing.
  const raw = JSON.stringify({
    entity: 'event',
    event: 'refund.processed',
    payload: { refund: { entity: { id: (await Order.findById(order._id).lean()).refund.razorpayRefundId, payment_id: (await Order.findById(order._id).lean()).razorpayPaymentId, amount: 35700, status: 'processed' } } },
    created_at: Math.floor(Date.now() / 1000),
  });
  await srv.request('POST', '/api/webhooks/razorpay', { raw, headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': 'evt_rfnd' } });
  assert.equal((await Order.findById(order._id).lean()).paymentStatus, 'refunded');
  assert.equal((await stockOf(subs[1])).remaining, 10, 'stock returned once');
  assert.equal(await issue.voidForSource({ sourceType: 'order', sourceId: order._id }), 0);

  // A refunded order never issues again.
  assert.deepEqual(await issue.issueForPayment({ sourceType: 'order', sourceId: order._id }), []);
});

test('a refund that lands while coupons are being issued takes them straight back', async () => {
  const cat = await category();
  const p = await partner({ cat });
  const order = await createPendingOnlineOrder(seed, { paymentStatus: 'paid', razorpayPaymentId: 'pay_x' });
  // Mark the order refunded the moment the coupon is written.
  const realCreate = Coupon.create.bind(Coupon);
  const create = mock.method(Coupon, 'create', async (doc) => {
    const made = await realCreate(doc);
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'refunded' } });
    return made;
  });
  try {
    await issue.issueForPayment({ sourceType: 'order', sourceId: order._id });
  } finally {
    create.mock.restore();
  }
  const [c] = await couponsFor('order', order._id);
  assert.equal(c.status, 'void');
  assert.equal((await stockOf(p.sub)).remaining, 10);
});

// ── Customer profile ──────────────────────────────────────────────────────────

const patchMe = (body, headers = customerHeaders()) => srv.request('PATCH', '/api/users/me', { headers, body });
const dobYearsAgo = (years, dayShift = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayShift);
  return d.toISOString().slice(0, 10);
};

test('PATCH /api/users/me: gender and date of birth validated, returned by GET, clearable', async () => {
  const ok = await patchMe({ gender: 'female', dateOfBirth: '1995-04-12' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const me = await srv.get('/api/users/me', customerHeaders());
  assert.equal(me.body.data.user.gender, 'female');
  assert.equal(me.body.data.user.dateOfBirth.slice(0, 10), '1995-04-12');

  for (const [body, label] of [
    [{ gender: 'unknown' }, 'unknown gender'],
    [{ dateOfBirth: '12-04-1995' }, 'wrong format'],
    [{ dateOfBirth: '2001-02-30' }, 'not a real date'],
    [{ dateOfBirth: dobYearsAgo(13, 2) }, 'a day short of 13'],
    [{ dateOfBirth: dobYearsAgo(111) }, 'over 110'],
    [{ dateOfBirth: dobYearsAgo(-1) }, 'in the future'],
  ]) {
    const res = await patchMe(body);
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
  assert.equal((await patchMe({ dateOfBirth: dobYearsAgo(13) })).status, 200, 'exactly 13 today');
  assert.equal((await patchMe({ dateOfBirth: dobYearsAgo(110) })).status, 200, '110');

  const cleared = await patchMe({ gender: null, dateOfBirth: null });
  assert.equal(cleared.status, 200);
  const after = await User.findById(seed.customer._id).lean();
  assert.equal(after.gender, null);
  assert.equal(after.dateOfBirth, null);

  // Untouched fields are unchanged by an unrelated update (backward compatible).
  await patchMe({ gender: 'male' });
  assert.equal((await patchMe({ name: 'Asha Rao' })).status, 200);
  assert.equal((await User.findById(seed.customer._id).lean()).gender, 'male');
});

test('the coupon keeps the customer as they were at issue; a later profile change does not alter it', async () => {
  const cat = await category();
  await partner({ cat });
  await patchMe({ gender: 'female', dateOfBirth: '1990-06-01' });
  const { order } = await payOrder();
  await patchMe({ gender: 'other', dateOfBirth: '1985-01-01', name: 'Someone Else' });
  const [c] = await couponsFor('order', order._id);
  assert.equal(c.customerSnapshot.gender, 'female');
  assert.equal(c.customerSnapshot.dateOfBirth.toISOString().slice(0, 10), '1990-06-01');
  assert.equal(c.customerSnapshot.name, 'Asha');
  assert.equal(c.customerSnapshot.phone, undefined, 'the phone is never copied');
});

// ── My Coupons ────────────────────────────────────────────────────────────────

test('My Coupons: own customer coupons only — never complimentary, never another customer\'s', async () => {
  const cat = await category();
  const p = await partner({ cat, name: 'Glow Salon & Spa' });
  const { order } = await payOrder();
  const [mine] = await couponsFor('order', order._id);

  const other = await User.create({ name: 'Ravi', phone: '9123456780', role: 'customer' });
  const { order: theirs } = await payOrder({}, other);
  const [theirCoupon] = await couponsFor('order', theirs._id);

  const complimentary = await Coupon.create({
    code: 'CMPLMNTRY2',
    kind: 'complimentary',
    sellerId: p.seller._id,
    subscriptionId: p.sub._id,
    categoryId: cat._id,
    customerId: seed.customer._id, // even if one were ever tied to a customer id
    source: { type: 'plan', id: p.sub._id },
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  const list = await srv.get('/api/users/me/coupons', customerHeaders());
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 1);
  const [view] = list.body.data.coupons;
  assert.equal(view.id, String(mine._id));
  assert.equal(view.code, mine.code);
  assert.equal(view.qrPayload, mine.code);
  assert.equal(view.title, p.offer.title);
  assert.equal(view.terms, 'One per visit');
  assert.equal(view.seller.name, 'Glow Salon & Spa');
  assert.equal(view.seller.phone, '9811111111');
  assert.match(view.seller.address, /12 MG Road/);
  assert.equal(view.category.name, cat.name);
  assert.equal(view.status, 'issued');
  assert.ok(view.issuedAt && view.expiresAt);
  assert.ok(!/complimentary|panLast4|aadhaar|ownerphone/i.test(JSON.stringify(list.body)), 'nothing internal leaks');

  const detail = await srv.get(`/api/users/me/coupons/${mine._id}`, customerHeaders());
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.coupon.code, mine.code);
  for (const id of [theirCoupon._id, complimentary._id, new mongoose.Types.ObjectId(), 'not-an-id']) {
    assert.equal((await srv.get(`/api/users/me/coupons/${id}`, customerHeaders())).status, 404, `coupon ${id}`);
  }
  assert.equal((await srv.get('/api/users/me/coupons')).status, 401);
});

test('My Coupons: status filter (a past-date coupon reads as expired), paging, couponsEarned on the order', async () => {
  const cats = [await category(), await category(), await category()];
  for (const cat of cats) await partner({ cat });
  const { order } = await payOrder();
  const coupons = await couponsFor('order', order._id);
  assert.equal(coupons.length, 3);
  await Coupon.updateOne({ _id: coupons[0]._id }, { $set: { status: 'redeemed', redeemedAt: new Date() } });
  await Coupon.updateOne({ _id: coupons[1]._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const get = (q) => srv.get(`/api/users/me/coupons${q}`, customerHeaders()).then((r) => r.body.data);
  assert.equal((await get('?status=issued')).total, 1);
  assert.equal((await get('?status=redeemed')).total, 1);
  const expired = await get('?status=expired');
  assert.equal(expired.total, 1);
  assert.equal(expired.coupons[0].status, 'expired');
  assert.equal((await get('?status=void')).total, 0);
  const page = await get('?limit=2&page=2');
  assert.equal(page.total, 3);
  assert.equal(page.coupons.length, 1);
  assert.equal((await srv.get('/api/users/me/coupons?status=bogus', customerHeaders())).status, 400);

  const detail = await srv.get(`/api/orders/${order._id}`, customerHeaders());
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.order.couponsEarned.count, 3);
  assert.deepEqual(
    [...detail.body.data.order.couponsEarned.ids].sort(),
    coupons.map((c) => String(c._id)).sort()
  );
});
