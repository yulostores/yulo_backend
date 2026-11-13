// CB11 — the whole coupon workflow, end to end, through HTTP only (plus the scheduler tick):
// seller signs up → onboards → submits → admin approves → buys Basic via Razorpay → a second
// seller is activated by Amount Received → admin enables two categories and approves offers →
// customer sets gender/DOB → pays a delivery order (2 coupons) → pays a dine-in bill (2 more) →
// an employee redeems one (a second redeem 409s) → admin CSV has the phone, the seller report
// doesn't → refund voids → reminders (seller credits + admin campaign) → the clock passes expiry and
// the tick expires the rest → every dashboard and report number checked.
// In-memory MongoDB and Redis; Razorpay, Cloudinary and SMS are stubs. Nothing leaves the process.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  seedBasics,
  createPendingOnlineOrder,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const fx = await import('../test-utils/sellerFixtures.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const otp = await import('../services/otp.service.js');
const auth = await import('../services/auth.service.js');
const redemption = await import('../services/couponRedeem.service.js');
const issue = await import('../services/couponIssue.service.js');
const sms = await import('../services/sms/templateSender.js');
const { runCouponTick } = await import('../jobs/couponScheduler.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: SellerSubscription } = await import('../models/SellerSubscription.js');
const { default: SmsLog } = await import('../models/SmsLog.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: User } = await import('../models/User.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const models = await Promise.all(
  ['WebhookEvent', 'IdempotencyKey', 'RestaurantLedgerEntry', 'CouponPlan', 'SmsCampaign', 'StrayPayment'].map(async (m) => (await import(`../models/${m}.js`)).default)
);

const redis = fakeRedis();
let mongo;
let srv;
let fake;
let cloud;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Seller.init(), Coupon.init(), SellerSubscription.init(), SmsLog.init(), ...models.map((m) => m.init())]);
  otp.__setOtpRedisForTests(redis);
  auth.__setAuthRedisForTests(redis);
  redemption.__setRedeemRedisForTests(redis);
  srv = await startTestServer({ withSocket: true });
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  cloud = await fx.mockCloudinary();
  __resetCouponSettingsCache();
  __resetFinanceSettingsCache();
  sms.__clearMockOutbox();
});
after(async () => {
  cloud?.restore();
  __setRazorpayForTests(undefined);
  otp.__setOtpRedisForTests(undefined);
  auth.__setAuthRedisForTests(undefined);
  redemption.__setRedeemRedisForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});

const req = async (method, path, { body, headers, expect = 200 } = {}) => {
  const res = await srv.request(method, path, { body, headers });
  if (expect !== null) assert.equal(res.status, expect, `${method} ${path}: ${JSON.stringify(res.body)}`);
  return res;
};
const data = async (...args) => (await req(...args)).body.data;
const IST = 330 * 60_000;
const DAY = 86_400_000;
/** 10:10 (or another hour) in India on the IST calendar day of `instant`. */
const istAt = (instant, hh = 10, mm = 10) => {
  const day = new Date(instant.getTime() + IST).toISOString().slice(0, 10);
  return new Date(new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`).getTime() - IST);
};

test('the whole coupon workflow, end to end', async () => {
  // ── Setup: reference data, a restaurant + customer, an admin ─────────────────
  await seedCouponData({ apply: true, log: () => {} });
  const base = await seedBasics(); // restaurant at [77.59, 12.97], customer Asha 9876543210
  const customer = base.customer;
  const customerH = { authorization: `Bearer ${base.customerToken}` };
  const adminUser = await User.create({ name: 'Root', email: 'root@test.local', role: 'admin' });
  const adminH = { authorization: `Bearer ${auth.generateTokens(adminUser._id, 'admin').accessToken}` };
  const salon = await CouponCategory.findOne({ key: 'salon' }).lean();
  const spa = await CouponCategory.findOne({ key: 'spa' }).lean();
  const safe = { customerPhones: [customer.phone], customerIds: [String(customer._id)] };

  // ── 1. Seller A signs up with an OTP ────────────────────────────────────────
  const OWNER_PHONE = '9822222221';
  const categories = await data('GET', '/api/seller/auth/categories');
  assert.ok(categories.categories.some((c) => c.key === 'salon'));
  const { devOtp } = await data('POST', '/api/seller/auth/otp/send', { body: { phone: OWNER_PHONE } });
  const verified = await data('POST', '/api/seller/auth/otp/verify', { body: { phone: OWNER_PHONE, code: devOtp } });
  assert.equal(verified.needsSignup, true);
  const signup = await data('POST', '/api/seller/auth/signup', {
    body: { signupToken: verified.signupToken, businessName: 'Glow Salon', categoryId: String(salon._id), ownerName: 'Asha Rao' },
    expect: 201,
  });
  const ownerA = { authorization: `Bearer ${signup.accessToken}` };
  const sellerAId = signup.seller._id;
  assert.equal((await data('GET', '/api/seller/status', { headers: ownerA })).status, 'pending');
  await req('GET', '/api/seller/dashboard', { headers: ownerA, expect: 403 }); // not approved yet

  // ── 2. Onboarding, then submit ─────────────────────────────────────────────
  await req('PUT', '/api/seller/onboarding/business', { headers: ownerA, body: fx.businessBody(salon._id) });
  await req('PUT', '/api/seller/onboarding/owner', { headers: ownerA, body: fx.ownerBody({ phone: OWNER_PHONE }) });
  for (const type of ['pan_card', 'aadhaar_card', 'gst_certificate']) {
    const up = await fx.uploadFile(srv.base, '/api/seller/onboarding/documents', ownerA, { type });
    assert.equal(up.status, 200, JSON.stringify(up.body));
  }
  const submitted = await data('POST', '/api/seller/onboarding/submit', { headers: ownerA });
  assert.deepEqual(submitted.missing, []);

  // ── 3. Admin approves ──────────────────────────────────────────────────────
  const queue = await data('GET', '/api/admin/sellers?status=pending', { headers: adminH });
  assert.ok(queue.sellers.some((s) => String(s._id) === sellerAId));
  await req('PATCH', `/api/admin/sellers/${sellerAId}/approve`, { headers: adminH });
  assert.equal((await data('GET', '/api/seller/status', { headers: ownerA })).status, 'active');

  // ── 4. Seller A buys Basic through Razorpay (verify) ───────────────────────
  const plans = await data('GET', '/api/seller/plans', { headers: ownerA });
  assert.deepEqual(plans.plans.map((p) => p.price.total), [5900, 17700, 59000]);
  const bought = await data('POST', '/api/seller/subscriptions', { headers: ownerA, body: { planKey: 'basic' }, expect: 201 });
  fake.addPayment({ id: 'pay_plan_a', order_id: bought.razorpayOrder.id, amount: 590_000 });
  await req('POST', `/api/seller/subscriptions/${bought.subscription._id}/verify`, {
    headers: ownerA,
    body: { razorpay_order_id: bought.razorpayOrder.id, razorpay_payment_id: 'pay_plan_a', razorpay_signature: checkoutSignature(bought.razorpayOrder.id, 'pay_plan_a') },
  });
  const subsA = await data('GET', '/api/seller/subscriptions', { headers: ownerA });
  assert.deepEqual(subsA.stock, { allocated: 250, issued: 0, remaining: 250 });

  // ── 5. Seller B (spa) — approved, then activated by "Amount Received" ──────
  const b = await fx.makeCompleteSeller({ status: 'pending', categoryId: spa._id, phone: '9000000002' });
  await SellerUser.updateOne({ _id: b.owner._id }, { $set: { name: 'Bina Shah' } });
  await Seller.updateOne({ _id: b.seller._id }, { $set: { businessName: 'Calm Spa', 'owner.phone': '9000000002' } });
  await req('PATCH', `/api/admin/sellers/${b.seller._id}/approve`, { headers: adminH });
  const ownerB = fx.sellerHeaders(await SellerUser.findById(b.owner._id));
  await req('PATCH', '/api/seller/profile', { headers: ownerB, body: { location: { lat: 12.975, lng: 77.592 } } });
  await req('POST', `/api/admin/sellers/${b.seller._id}/subscriptions/manual`, {
    headers: adminH,
    body: { planKey: 'plus', amountRupees: 17700, mode: 'neft', reference: 'UTR123456789', receivedOn: new Date().toISOString().slice(0, 10) },
    expect: 201,
  });

  // ── 6. Admin enables two categories; both sellers' offers approved ─────────
  for (const cat of [salon, spa]) await req('PATCH', `/api/admin/coupon-categories/${cat._id}`, { headers: adminH, body: { enabled: true } });
  for (const [h, title] of [[ownerA, '20% off any haircut'], [ownerB, 'Free foot massage']]) {
    const offer = (await data('POST', '/api/seller/offers', { headers: h, body: { title, terms: 'One per visit' }, expect: 201 })).offer;
    await req('POST', `/api/seller/offers/${offer._id}/submit`, { headers: h });
    const pending = (await data('GET', '/api/admin/coupon-offers?status=pending_review', { headers: adminH })).offers.find((o) => String(o._id) === String(offer._id));
    await req('PATCH', `/api/admin/coupon-offers/${offer._id}/approve`, { headers: adminH, body: { updatedAt: pending.updatedAt } });
  }
  const cats = (await data('GET', '/api/admin/coupon-categories', { headers: adminH })).categories;
  assert.equal(cats.find((c) => c.key === 'salon').sellersWithLiveOffer, 1);

  // ── 7. The customer sets gender and date of birth ──────────────────────────
  await req('PATCH', '/api/users/me', { headers: customerH, body: { gender: 'female', dateOfBirth: '1995-04-12' } });

  // ── 8. A delivery order paid online → 2 coupons ────────────────────────────
  const order = await createPendingOnlineOrder(base);
  fake.addPayment({ id: 'pay_order_1', order_id: order.paymentIntentId, amount: order.paymentAmountPaise });
  await req('POST', `/api/orders/${order._id}/payment/verify`, {
    headers: customerH,
    body: { razorpay_payment_id: 'pay_order_1', razorpay_order_id: order.paymentIntentId, razorpay_signature: checkoutSignature(order.paymentIntentId, 'pay_order_1') },
  });
  await issue.settleScheduledIssues();
  const orderView = (await data('GET', `/api/orders/${order._id}`, { headers: customerH })).order;
  assert.equal(orderView.couponsEarned.count, 2);

  // ── 9. A dine-in bill paid online → 2 more ─────────────────────────────────
  const table = await Table.create({ restaurantId: base.restaurant._id, identifier: 'T1' });
  const session = await TableSession.create({ restaurantId: base.restaurant._id, tableId: table._id, guestName: 'Asha' });
  const round = await Order.create({
    restaurantId: base.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    userId: customer._id,
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: base.dish._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: round._id } });
  const billBase = `/api/restaurants/${base.restaurant._id}/tables/${table._id}/bill`;
  const { razorpayOrder: billOrder } = await data('POST', `${billBase}/pay`);
  fake.addPayment({ id: 'pay_bill_1', order_id: billOrder.id, amount: billOrder.amount });
  await req('POST', `${billBase}/verify`, { body: { razorpay_payment_id: 'pay_bill_1', razorpay_order_id: billOrder.id, razorpay_signature: checkoutSignature(billOrder.id, 'pay_bill_1') } });
  await issue.settleScheduledIssues();
  const bill = await Bill.findOne({ tableSessionId: session._id }).lean();
  const poll = await data('GET', `${billBase}/payment?razorpayOrderId=${billOrder.id}`, { headers: customerH });
  assert.equal(poll.bill.couponsEarned.count, 2);

  const mine = await data('GET', '/api/users/me/coupons', { headers: customerH });
  assert.equal(mine.total, 4);
  const byKey = {};
  for (const c of mine.coupons) byKey[`${c.source.type}:${c.category.key}`] = c;
  assert.deepEqual(Object.keys(byKey).sort(), ['bill:salon', 'bill:spa', 'order:salon', 'order:spa']);
  assert.equal(byKey['order:salon'].seller.name, 'Glow Salon');
  assert.equal(byKey['order:spa'].seller.name, 'Calm Spa');
  assert.equal(byKey['order:salon'].title, '20% off any haircut');

  // ── 10. Seller A's owner adds an employee, who redeems one; again → 409 ────
  const added = await data('POST', '/api/seller/users', { headers: ownerA, body: { name: 'Ravi Kumar', phone: '9700000002', role: 'employee' }, expect: 201 });
  const employeeH = fx.sellerHeaders(await SellerUser.findById(added.member._id));
  const code = byKey['order:salon'].code;
  const look = await data('POST', '/api/seller/redeem/lookup', { headers: employeeH, body: { code } });
  assert.equal(look.coupon.customerFirstName, 'Asha');
  fx.assertSellerSafe(look, { ...safe, label: 'lookup' });
  await req('POST', '/api/seller/redeem', { headers: employeeH, body: { code } });
  const again = await req('POST', '/api/seller/redeem', { headers: employeeH, body: { code }, expect: 409 });
  assert.equal(again.body.code, 'COUPON_ALREADY_REDEEMED');
  assert.equal(again.body.details.redeemedByName, 'Ravi Kumar');
  // Seller B can't even see A's code.
  await req('POST', '/api/seller/redeem/lookup', { headers: ownerB, body: { code: byKey['bill:salon'].code }, expect: 404 });

  // ── 11. Admin CSV has the mobile; the seller's report never does ──────────
  const csv = await srv.get('/api/admin/coupons/export.csv?kind=customer', adminH);
  assert.equal(csv.status, 200);
  assert.ok(csv.body.includes(customer.phone), 'admin export carries the mobile');
  assert.ok(await AdminActivityLog.exists({ action: 'COUPONS_EXPORTED' }));
  const sellerCsv = await srv.get('/api/seller/reports/coupons.csv', ownerA);
  assert.equal(sellerCsv.status, 200);
  fx.assertSellerSafe(sellerCsv.body, { ...safe, label: 'seller csv' });
  for (const path of ['/dashboard', '/reports/coupons', '/reports/demographics', '/redeem/today']) {
    fx.assertSellerSafe((await req('GET', `/api/seller${path}`, { headers: ownerA })).body, { ...safe, label: path });
  }

  // ── 12. The customer cancels the delivery order → full refund → its unused coupon is void ─
  await req('POST', `/api/orders/${order._id}/cancel`, { headers: customerH, body: {} });
  const orderCoupons = await Coupon.find({ 'source.type': 'order', 'source.id': order._id }).populate('categoryId').lean();
  assert.deepEqual(orderCoupons.map((c) => [c.categoryId.key, c.status]).sort(), [['salon', 'redeemed'], ['spa', 'void']]);

  // ── 13. Reminders: seller A buys credits (Amount Received); admin queues a campaign ─
  await req('POST', `/api/admin/sellers/${sellerAId}/sms-credits/manual`, {
    headers: adminH,
    body: { credits: 10, amountRupees: 35.4, mode: 'upi', reference: 'UPI-SMS-0001', receivedOn: new Date().toISOString().slice(0, 10) },
    expect: 201,
  });
  const billCoupons = await Coupon.find({ 'source.type': 'bill', 'source.id': bill._id }).lean();
  const expiry = new Date(Math.max(...billCoupons.map((c) => c.expiresAt.getTime())));
  const window = { expiringTo: new Date(expiry.getTime() + 5 * DAY + IST).toISOString().slice(0, 10) };
  const preview = await data('POST', '/api/admin/reminder-campaigns/preview', { headers: adminH, body: window });
  assert.equal(preview.recipientCount, 2, 'the two bill coupons (order: one redeemed, one void)');
  assert.equal(preview.cost.totalPaise, 708);
  const campaign = (await data('POST', '/api/admin/reminder-campaigns', { headers: adminH, body: window, expect: 201 })).campaign;

  // Two days before expiry, 10:10 IST: seller A's credits remind its customer; Yulo's campaign goes out.
  const remindAt = istAt(new Date(expiry.getTime() - 2 * DAY));
  const tick = await runCouponTick({ now: remindAt, redis: fakeRedis() });
  assert.equal(tick.reminders, 'ran');
  const reminders = await data('GET', '/api/seller/reminders', { headers: ownerA });
  assert.equal(reminders.credits, 9, 'one SMS, one credit');
  assert.equal(reminders.sent.length, 1);
  fx.assertSellerSafe(reminders, { ...safe, label: 'reminders' });
  const detail = await data('GET', `/api/admin/reminder-campaigns/${campaign._id}`, { headers: adminH });
  assert.deepEqual(detail.campaign.counts, { sent: 2, failed: 0 });
  assert.ok(detail.log.every((l) => l.phone === '******3210'));
  assert.equal(sms.__mockOutbox().length, 3);

  // ── 14. The clock passes expiry: the 02:00 tick expires what's left ────────
  const expireAt = istAt(new Date(expiry.getTime() + DAY), 2, 10);
  assert.equal((await runCouponTick({ now: expireAt, redis: fakeRedis() })).expiry, 'ran');
  const statuses = await Coupon.aggregate([{ $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } }]);
  const count = (kind, status) => statuses.find((s) => s._id.kind === kind && s._id.status === status)?.n ?? 0;
  assert.equal(count('customer', 'redeemed'), 1);
  assert.equal(count('customer', 'void'), 1);
  assert.equal(count('customer', 'expired'), 2);
  assert.equal(count('customer', 'issued'), 0);
  assert.equal(count('complimentary', 'expired'), 10, 'both plans\' 5 complimentary each, never handed out');

  // ── 15. Every number ───────────────────────────────────────────────────────
  const dashA = await data('GET', '/api/seller/dashboard', { headers: ownerA });
  assert.deepEqual(dashA.stock, { allocated: 250, issued: 2, pending: 248 });
  assert.deepEqual(dashA.coupons, { issued: 2, active: 0, redeemed: 1, expired: 1, void: 0, redemptionRate: 50 });
  fx.assertSellerSafe(dashA, { ...safe, label: 'dashboard A' });
  const dashB = await data('GET', '/api/seller/dashboard', { headers: ownerB });
  assert.deepEqual(dashB.stock, { allocated: 900, issued: 1, pending: 899 }, 'the voided coupon went back to stock');
  assert.deepEqual(dashB.coupons, { issued: 1, active: 0, redeemed: 0, expired: 1, void: 1, redemptionRate: 0 });

  const demoA = await data('GET', '/api/seller/reports/demographics', { headers: ownerA });
  assert.deepEqual(demoA.gender, { male: 0, female: 2, other: 0, not_given: 0 });
  assert.equal(demoA.ageBands['25-34'], 2);
  const listA = await data('GET', '/api/seller/reports/coupons', { headers: ownerA });
  assert.deepEqual(listA.coupons.map((c) => c.status).sort(), ['expired', 'redeemed']);
  assert.equal(listA.coupons.find((c) => c.status === 'redeemed').redeemedByName, 'Ravi Kumar');
  assert.equal(listA.coupons[0].customerName, 'Asha');

  const summary = await data('GET', '/api/admin/coupon-reports/summary', { headers: adminH });
  assert.deepEqual(
    { issued: summary.issued, active: summary.active, redeemed: summary.redeemed, expired: summary.expired, void: summary.void, pending: summary.pending, rate: summary.redemptionRate },
    { issued: 3, active: 0, redeemed: 1, expired: 2, void: 1, pending: 1147, rate: 33.33 }
  );
  assert.deepEqual(summary.complimentary, { total: 10, assigned: 0, used: 0, expired: 10, unused: 0 });
  const byCat = (await data('GET', '/api/admin/coupon-reports/by-category', { headers: adminH })).categories;
  assert.deepEqual(
    byCat.filter((c) => c.issued || c.void).map((c) => [c.key, c.issued, c.redeemed, c.expired, c.void]),
    [['salon', 2, 1, 1, 0], ['spa', 1, 0, 1, 1]]
  );
  const bySeller = (await data('GET', '/api/admin/coupon-reports/by-seller', { headers: adminH })).sellers;
  assert.deepEqual(bySeller.map((s) => [s.name, s.issued]), [['Glow Salon', 2], ['Calm Spa', 1]]);
  const demo = await data('GET', '/api/admin/coupon-reports/demographics', { headers: adminH });
  assert.deepEqual(demo.gender, { male: 0, female: 4, other: 0, not_given: 0 });
  const employees = (await data('GET', '/api/admin/coupon-reports/employees', { headers: adminH })).employees;
  assert.equal(employees.find((e) => e.name === 'Ravi Kumar').redemptions, 1);
  assert.equal(employees.find((e) => e.name === 'Ravi Kumar').phone, '9700000002');
  const sellersReport = (await data('GET', '/api/admin/coupon-reports/sellers', { headers: adminH })).sellers;
  const glow = sellersReport.find((s) => s.businessName === 'Glow Salon');
  assert.deepEqual([glow.currentPlan.name, glow.allocated, glow.issued, glow.pending, glow.redeemed, glow.expired], ['Basic', 250, 2, 248, 1, 1]);
  const adminList = await data('GET', '/api/admin/coupons?kind=customer', { headers: adminH });
  assert.equal(adminList.total, 4);
  assert.ok(adminList.coupons.every((c) => c.mobile === customer.phone && c.age === 31 && c.gender === 'female'));

  const myAfter = await data('GET', '/api/users/me/coupons', { headers: customerH });
  assert.deepEqual(myAfter.coupons.map((c) => c.status).sort(), ['expired', 'expired', 'redeemed', 'void']);
});
