// Round-4 fixes from device testing — riders missing orders, and unpaid orders reaching the
// restaurant:
//   - an accepted order no rider was connected for keeps being offered (sweepUnassignedOrders);
//   - a rider who missed or skipped an offer is offered the order again after a cooldown;
//   - two searches at once can't overwrite each other's offer;
//   - each offer is also pushed to the rider's phone (Expo push — recorded here, never sent);
//   - the socket join answers whether it worked, so the app can refresh an expired token;
//   - an online order nobody has paid for stays out of the restaurant's inbox, list and
//     dashboard, appears once paid, and lapses with an honest reason.
// In-memory MongoDB, fake Razorpay, presence stubbed (no Redis in tests).

import test, { after, afterEach, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, checkoutSignature } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { __setPushSenderForTests } = await import('../services/push.service.js');
const assignment = await import('../services/deliveryAssignment.service.js');
const kitchenService = await import('../services/kitchen.service.js');
const { recordCapturedPayment } = await import('../services/payment.service.js');
const { expireUnansweredOrders, PAYMENT_TIMEOUT_REASON, APPROVAL_TIMEOUT_REASON } = await import(
  '../services/orderApproval.service.js'
);
const { generateTokens, generatePartnerTokens } = await import('../services/auth.service.js');
const { env } = await import('../config/env.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Order } = await import('../models/Order.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');

const RESTAURANT_AT = [77.59, 12.97];
const DROP = [77.599, 12.97];
const MIN = 60 * 1000;
const TOKEN_A = 'ExponentPushToken[riderAAAAAAAAAAAAAAAAAA]';
const TOKEN_B = 'ExponentPushToken[riderBBBBBBBBBBBBBBBBBB]';

let mongo;
let srv;
let fake;
let restaurant;
let thali;
let owner;
let customer;
let riderA;
let riderB;
let online = [];
let pushes = [];

const req = (method, path, opts = {}) => srv.request(method, path, opts);
const ok = (res, status = 200) => {
  assert.equal(res.status, status, `${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.body.data;
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const ownerH = () => bearer(generateTokens(owner._id, 'restaurant_owner').accessToken);
const customerH = () => bearer(generateTokens(customer._id, 'customer').accessToken);
const riderH = (rider) => bearer(generatePartnerTokens(rider._id).accessToken);
// Pushes are sent without being awaited — let them land before looking.
const settle = () => new Promise((r) => setTimeout(r, 50));
const offerPushes = () => pushes.filter((m) => m.data?.type === 'order_offer');

before(async () => {
  mongo = await startMemoryMongo();
  // The rider search is a $near query: it needs the 2dsphere index built before the first test.
  await Promise.all([DeliveryPartner.init(), Restaurant.init(), Order.init()]);
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  assignment.__setPresenceForTests(async () => online);
  __setPushSenderForTests(async (messages) => {
    pushes.push(...messages);
    return messages.map(() => ({ status: 'ok' }));
  });
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  assignment.__setPresenceForTests(null);
  __setPushSenderForTests(null);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  online = [];
  pushes = [];
  owner = await User.create({ name: 'Owner', email: 'owner@test.local', role: 'restaurant_owner' });
  customer = await User.create({
    name: 'Asha',
    phone: '9876543210',
    role: 'customer',
    savedAddresses: [
      { street: '22 Lake Road', city: 'Bengaluru', pincode: '560001', location: { type: 'Point', coordinates: DROP }, locationSource: 'map_pin', isDefault: true },
    ],
  });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Spice Route',
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    delivery: { radiusKm: 10 },
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Thalis' });
  thali = await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: 'Thali', foodType: 'veg', sellingPrice: 300 });
  riderA = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', status: 'active', verificationStatus: 'approved', pushToken: TOKEN_A });
  riderB = await DeliveryPartner.create({ phone: '9222222222', fullName: 'Meena', status: 'active', verificationStatus: 'approved', pushToken: TOKEN_B });
});
afterEach(settle);

// An accepted (confirmed) cash delivery order, waiting for a rider.
const acceptedOrder = (extra = {}) =>
  Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'confirmed',
    items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 300,
    paymentMethod: 'cash',
    paymentStatus: 'pending_cod',
    deliveryAddress: { street: '22 Lake Road', city: 'Bengaluru', coordinates: DROP },
    ...extra,
  });

const assignmentOf = async (order) => (await Order.findById(order._id).lean()).deliveryAssignment;

// ── Dispatch ──────────────────────────────────────────────────────────────────

test('an order accepted while no rider was connected is offered as soon as one connects', async () => {
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'placed',
    items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 300,
    paymentMethod: 'cash',
    paymentStatus: 'pending_cod',
    deliveryAddress: { street: '22 Lake Road', city: 'Bengaluru', coordinates: DROP },
  });
  await kitchenService.updateOrderStatus({ orderId: order._id, currentStatus: 'placed', newStatus: 'confirmed', actor: { role: 'owner' } });
  assert.equal((await assignmentOf(order)).offerStatus, 'none', 'nobody online at acceptance');

  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'none', 'still nobody online');

  online = [String(riderA._id)];
  await assignment.sweepUnassignedOrders();
  const da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'offered');
  assert.equal(String(da.offeredTo), String(riderA._id));

  await settle();
  assert.equal(offerPushes().length, 1);
  const [push] = offerPushes();
  assert.equal(push.to, TOKEN_A);
  assert.equal(push.channelId, 'order-offers');
  assert.equal(push.data.orderId, String(order._id));
  assert.equal(push.ttl, env.DELIVERY_OFFER_WINDOW_SECONDS);
  assert.match(push.body, /Spice Route/);

  // A live offer isn't offered again on the next sweep.
  await assignment.sweepUnassignedOrders();
  await settle();
  assert.equal(offerPushes().length, 1);
});

test('an order stuck without a rider for hours is left alone by the sweep (no offers for stale orders)', async () => {
  online = [String(riderA._id)];
  const stale = await acceptedOrder();
  await Order.collection.updateOne(
    { _id: stale._id },
    { $set: { createdAt: new Date(Date.now() - assignment.WAITING_ORDER_MAX_AGE_MS - MIN) } }
  );
  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(stale)).offerStatus, 'none');
  await settle();
  assert.equal(offerPushes().length, 0);
});

test('a rider who let an offer lapse is offered the same order again after the cooldown', async () => {
  online = [String(riderA._id)];
  const order = await acceptedOrder();
  await assignment.autoAssign(order);
  assert.equal(String((await assignmentOf(order)).offeredTo), String(riderA._id));

  // The offer lapses (the rider's phone never showed it).
  await Order.updateOne({ _id: order._id }, { $set: { 'deliveryAssignment.offerExpiresAt': new Date(Date.now() - 1000) } });
  await assignment.sweepExpiredOffers();
  let da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'expired', 'not re-offered straight away');

  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'expired', 'still within the cooldown');

  // Cooldown over.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'deliveryAssignment.history.0.unassignedAt': new Date(Date.now() - assignment.REOFFER_COOLDOWN_MS - 1000) } }
  );
  await assignment.sweepUnassignedOrders();
  da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'offered');
  assert.equal(String(da.offeredTo), String(riderA._id));
});

test('a skipped order goes to the next rider at once, and back to the first only after the cooldown', async () => {
  online = [String(riderA._id), String(riderB._id)];
  const order = await acceptedOrder();
  await assignment.autoAssign(order);
  const first = String((await assignmentOf(order)).offeredTo);
  const second = first === String(riderA._id) ? riderB : riderA;
  const firstRider = first === String(riderA._id) ? riderA : riderB;

  ok(await req('POST', `/api/partner/orders/${order._id}/reject`, { headers: riderH(firstRider), body: { reason: 'Restaurant too far' } }));
  assert.equal(String((await assignmentOf(order)).offeredTo), String(second._id));

  // The second skips too: both are in their cooldown, so nobody is asked for now.
  ok(await req('POST', `/api/partner/orders/${order._id}/reject`, { headers: riderH(second), body: { reason: 'Taking a break' } }));
  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'rejected');

  // A skip keeps the rider out longer than a lapse: the lapse cooldown alone isn't enough.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'deliveryAssignment.history.0.unassignedAt': new Date(Date.now() - assignment.REOFFER_COOLDOWN_MS - 1000) } }
  );
  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'rejected', 'a skip is not undone after 2 minutes');

  // The first rider's (longer) skip cooldown ends first → they're asked again.
  await Order.updateOne(
    { _id: order._id },
    { $set: { 'deliveryAssignment.history.0.unassignedAt': new Date(Date.now() - assignment.REJECT_COOLDOWN_MS - 1000) } }
  );
  await assignment.sweepUnassignedOrders();
  const da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'offered');
  assert.equal(String(da.offeredTo), String(firstRider._id));
});

test('two searches for the same order at once leave one offer, not two', async () => {
  online = [String(riderA._id), String(riderB._id)];
  const order = await acceptedOrder();
  const results = await Promise.all([assignment.autoAssign(order), assignment.autoAssign(await Order.findById(order._id))]);
  assert.equal(results.filter(Boolean).length, 1);
  await settle();
  assert.equal(offerPushes().length, 1);
  const da = await assignmentOf(order);
  assert.equal(String(da.offeredTo), String(results.find(Boolean)));
});

test('a rider on an order, or with the order offered, is never sent it again', async () => {
  online = [String(riderA._id), String(riderB._id)];
  const order = await acceptedOrder({ deliveryAssignment: { partnerId: riderA._id, status: 'assigned' } });
  assert.equal(await assignment.autoAssign(order), null);
  await assignment.sweepUnassignedOrders();
  await settle();
  assert.equal(offerPushes().length, 0);
});

// ── Push tokens ───────────────────────────────────────────────────────────────

test('push token: saved, moved off another rider on the same phone, refused when malformed, cleared on sign-out', async () => {
  ok(await req('PUT', '/api/partner/notifications/push-token', { headers: riderH(riderB), body: { token: TOKEN_A } }));
  assert.equal((await DeliveryPartner.findById(riderB._id).lean()).pushToken, TOKEN_A);
  assert.equal((await DeliveryPartner.findById(riderA._id).lean()).pushToken, null, 'one phone, one rider');

  const bad = await req('PUT', '/api/partner/notifications/push-token', { headers: riderH(riderA), body: { token: 'not-a-token' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'VALIDATION_ERROR');

  ok(await req('DELETE', '/api/partner/notifications/push-token', { headers: riderH(riderB) }));
  assert.equal((await DeliveryPartner.findById(riderB._id).lean()).pushToken, null);

  const anon = await req('PUT', '/api/partner/notifications/push-token', { body: { token: TOKEN_A } });
  assert.equal(anon.status, 401);
});

test('no offer push for a rider who switched order notifications off; an unregistered phone is forgotten', async () => {
  online = [String(riderA._id)];
  await DeliveryPartner.updateOne({ _id: riderA._id }, { $set: { 'notificationPreferences.orders': false } });
  const order = await acceptedOrder();
  await assignment.autoAssign(order);
  await settle();
  assert.equal((await assignmentOf(order)).offerStatus, 'offered', 'still offered over the socket');
  assert.equal(offerPushes().length, 0);

  await DeliveryPartner.updateOne({ _id: riderA._id }, { $set: { 'notificationPreferences.orders': true } });
  __setPushSenderForTests(async (messages) => messages.map(() => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } })));
  try {
    const another = await acceptedOrder();
    // The first offer is over, so riderA is free to be offered another.
    await Order.updateOne({ _id: order._id }, { $set: { status: 'delivered', 'deliveryAssignment.offerStatus': 'expired' } });
    await assignment.autoAssign(another);
    await settle();
    assert.equal((await DeliveryPartner.findById(riderA._id).lean()).pushToken, null);
  } finally {
    __setPushSenderForTests(async (messages) => {
      pushes.push(...messages);
      return messages.map(() => ({ status: 'ok' }));
    });
  }
});

test('a cancelled order is pushed to the rider holding it', async () => {
  const order = await acceptedOrder({ deliveryAssignment: { partnerId: riderA._id, status: 'assigned' } });
  await kitchenService.updateOrderStatus({ orderId: order._id, currentStatus: 'confirmed', newStatus: 'cancelled', actor: { role: 'owner' }, reason: 'Out of stock' });
  await settle();
  const cancelled = pushes.filter((m) => m.data?.type === 'order_cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].to, TOKEN_A);
});

// ── Socket join answer ────────────────────────────────────────────────────────

// Socket.IO over plain HTTP long-polling — no client library needed. Packets in one poll are
// separated by \x1e; "40" connects to the default namespace; "42<id>[...]" emits with an ack id
// and the server answers "43<id>[...]".
const joinPartner = async (token) => {
  const url = `${srv.base}/socket.io/?EIO=4&transport=polling`;
  const open = await (await fetch(url)).text();
  const { sid } = JSON.parse(open.slice(1));
  const at = `${url}&sid=${sid}`;
  await fetch(at, { method: 'POST', body: '40' });
  await (await fetch(at)).text(); // the namespace connect answer
  await fetch(at, { method: 'POST', body: `421${JSON.stringify(['join_partner', { token }])}` });
  for (let i = 0; i < 5; i += 1) {
    const packets = (await (await fetch(at)).text()).split('\x1e');
    const ack = packets.find((p) => p.startsWith('431'));
    if (ack) return JSON.parse(ack.slice(3))[0];
  }
  return null;
};

test('joining the rider room answers ok, or says the token was refused so the app can refresh it', async () => {
  assert.deepEqual(await joinPartner(generatePartnerTokens(riderA._id).accessToken), { ok: true });

  const expired = jwt.sign({ partnerId: String(riderA._id), exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_PARTNER_SECRET);
  assert.deepEqual(await joinPartner(expired), { ok: false, code: 'INVALID_TOKEN' });
});

// ── Unpaid online orders ──────────────────────────────────────────────────────

const placeOnlineOrder = async () => {
  ok(await req('POST', '/api/cart/items', { headers: customerH(), body: { menuItemId: String(thali._id), qty: 1 } }), 201);
  return ok(await req('POST', '/api/orders/checkout', { headers: customerH(), body: { paymentMethod: 'online' } }), 201);
};

const ownerSees = async (orderId) => {
  const pending = ok(await req('GET', `/api/owner/${restaurant._id}/orders/pending`, { headers: ownerH() }));
  const list = ok(await req('GET', `/api/owner/${restaurant._id}/orders`, { headers: ownerH() }));
  const has = (rows) => rows.some((o) => String(o._id) === String(orderId));
  return { inbox: has(pending.orders), inboxCount: pending.count, list: has(list.orders) };
};

test('an unpaid online order stays off the restaurant’s screens; it appears once paid', async () => {
  const placed = await placeOnlineOrder();
  assert.deepEqual(await ownerSees(placed.orderId), { inbox: false, inboxCount: 0, list: false });

  // A declined payment doesn't put it there either.
  await Order.updateOne({ _id: placed.orderId }, { $set: { paymentStatus: 'failed', paymentFailureReason: 'UPI app declined' } });
  assert.deepEqual(await ownerSees(placed.orderId), { inbox: false, inboxCount: 0, list: false });
  // …and the customer can still see and retry it.
  const mine = ok(await req('GET', `/api/orders/${placed.orderId}/payment`, { headers: customerH() }));
  assert.equal(mine.canRetry, true);

  // Paid → a new order for the restaurant.
  const rzp = placed.razorpayOrder;
  const retry = ok(await req('POST', `/api/orders/${placed.orderId}/payment/retry`, { headers: customerH() }));
  const rzpId = retry.razorpayOrder?.id ?? rzp.id;
  fake.addPayment({ id: 'pay_fix4paid0001', order_id: rzpId, amount: rzp.amount, fee: 1138, tax: 174 });
  ok(await req('POST', `/api/orders/${placed.orderId}/payment/verify`, {
    headers: customerH(),
    body: { razorpay_payment_id: 'pay_fix4paid0001', razorpay_order_id: rzpId, razorpay_signature: checkoutSignature(rzpId, 'pay_fix4paid0001') },
  }));
  assert.deepEqual(await ownerSees(placed.orderId), { inbox: true, inboxCount: 1, list: true });

  const dash = ok(await req('GET', `/api/owner/${restaurant._id}/dashboard`, { headers: ownerH() }));
  assert.equal(dash.kpis?.totalOrders ?? dash.totalOrders, 1);
});

test('the restaurant is told about an online order when it is paid, not when it is placed', async () => {
  const { getIO } = await import('../socket.js');
  const io = getIO();
  const emitted = [];
  const realTo = io.to.bind(io);
  io.to = (room) => {
    const target = realTo(room);
    return { emit: (event, payload) => { emitted.push({ room, event, orderId: String(payload?.orderId ?? '') }); return target.emit(event, payload); } };
  };
  try {
    const placed = await placeOnlineOrder();
    assert.equal(emitted.filter((e) => e.event === 'order_awaiting_approval').length, 0);

    const order = await Order.findById(placed.orderId);
    await recordCapturedPayment(order, 'pay_fix4sock0001', null, 'webhook');
    const announced = emitted.filter((e) => e.event === 'order_awaiting_approval');
    assert.equal(announced.length, 1);
    assert.equal(announced[0].room, `owner:${restaurant._id}`);
    assert.equal(announced[0].orderId, placed.orderId);
  } finally {
    io.to = realTo;
  }
});

test('an unpaid order that lapses says the payment wasn’t completed, not that the restaurant ignored it', async () => {
  const placed = await placeOnlineOrder();
  const cash = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'placed',
    items: [{ menuItemId: thali._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    paymentMethod: 'cash',
    paymentStatus: 'pending_cod',
  });
  const old = new Date(Date.now() - (env.ORDER_APPROVAL_TIMEOUT_MINUTES + 1) * MIN);
  await Order.collection.updateMany({ _id: { $in: [cash._id, new (await import('mongoose')).default.Types.ObjectId(placed.orderId)] } }, { $set: { createdAt: old } });

  assert.equal(await expireUnansweredOrders(), 2);
  const unpaid = await Order.findById(placed.orderId).lean();
  const cashAfter = await Order.findById(cash._id).lean();
  assert.equal(unpaid.status, 'cancelled');
  assert.equal(unpaid.statusHistory.at(-1).reason ?? unpaid.cancellationReason, PAYMENT_TIMEOUT_REASON);
  assert.equal(cashAfter.statusHistory.at(-1).reason ?? cashAfter.cancellationReason, APPROVAL_TIMEOUT_REASON);
});

// ── Review round: reach, caps, offer identity, expiry race ────────────────────

test('a rider whose socket Android closed (phone locked) is still offered the order — by push', async () => {
  online = []; // no live socket at all
  await DeliveryPartner.updateOne({ _id: riderA._id }, { $set: { currentLocationUpdatedAt: new Date(), currentLocation: { type: 'Point', coordinates: RESTAURANT_AT } } });
  const order = await acceptedOrder();
  await assignment.sweepUnassignedOrders();
  const da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'offered');
  assert.equal(String(da.offeredTo), String(riderA._id));
  await settle();
  assert.equal(offerPushes()[0]?.to, TOKEN_A);
});

test('…but not a rider with no push token, or whose phone has gone quiet', async () => {
  online = [];
  const stale = new Date(Date.now() - assignment.PUSH_REACHABLE_WITHIN_MS - MIN);
  await DeliveryPartner.updateOne({ _id: riderA._id }, { $set: { pushToken: null, currentLocationUpdatedAt: new Date() } });
  await DeliveryPartner.updateOne({ _id: riderB._id }, { $set: { currentLocationUpdatedAt: stale } });
  const order = await acceptedOrder();
  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'none');
});

test('nobody is asked about the same order more than the cap', async () => {
  online = [String(riderA._id)];
  const long = new Date(Date.now() - assignment.REJECT_COOLDOWN_MS - MIN);
  const history = Array.from({ length: assignment.REOFFER_MAX_PER_RIDER }, () => ({ partnerId: riderA._id, assignedAt: long, assignedBy: 'auto', unassignedAt: long, reason: 'expired' }));
  const order = await acceptedOrder({ deliveryAssignment: { status: 'unassigned', offerStatus: 'expired', history } });
  await assignment.sweepUnassignedOrders();
  assert.equal((await assignmentOf(order)).offerStatus, 'expired');
});

test('each offer carries its own expiry and the time actually left', async () => {
  online = [String(riderA._id)];
  const order = await acceptedOrder();
  await assignment.autoAssign(order);
  await settle();
  const da = await assignmentOf(order);
  const current = ok(await req('GET', '/api/partner/orders/current', { headers: riderH(riderA) }));
  assert.equal(current.kind, 'offer');
  assert.equal(new Date(current.order.offerExpiresAt).getTime(), da.offerExpiresAt.getTime());
  assert.ok(current.order.countdownSeconds <= env.DELIVERY_OFFER_WINDOW_SECONDS && current.order.countdownSeconds > 0);

  // Five seconds of the window gone → the resumed screen shows what's left, not a full window.
  await Order.updateOne({ _id: order._id }, { $set: { 'deliveryAssignment.offerExpiresAt': new Date(Date.now() + 3000) } });
  const later = ok(await req('GET', '/api/partner/orders/current', { headers: riderH(riderA) }));
  assert.ok(later.order.countdownSeconds <= 3, String(later.order.countdownSeconds));
});

test('expiring a stale offer never touches a newer offer written in the meantime', async () => {
  online = [String(riderA._id), String(riderB._id)];
  const order = await acceptedOrder();
  await assignment.autoAssign(order);
  await Order.updateOne({ _id: order._id }, { $set: { 'deliveryAssignment.offerExpiresAt': new Date(Date.now() - 1000) } });
  const staleCopy = await Order.findById(order._id); // what the sweep read

  // Meanwhile a fresh offer goes to rider B.
  const fresh = new Date(Date.now() + 20_000);
  await Order.updateOne({ _id: order._id }, { $set: { 'deliveryAssignment.offeredTo': riderB._id, 'deliveryAssignment.offerExpiresAt': fresh } });

  assert.equal(await assignment.expireIfStale(staleCopy), true);
  const da = await assignmentOf(order);
  assert.equal(da.offerStatus, 'offered', "rider B's live offer survives");
  assert.equal(String(da.offeredTo), String(riderB._id));
  assert.equal(da.history.length, 0);
});
