// CB10 — the coupon scheduler: the 02:00 IST expiry run and the 10:00 IST reminder run, their
// Redis lock and once-a-day marker, and the reminder rules — once per coupon, 1 credit per SMS,
// debited exactly and never below zero even with ticks racing, nothing without credits, a failed
// send gives its credit back, queued admin campaigns go out. Driven through runCouponTick with an
// injected clock and Redis; the SMS provider is the in-memory mock.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { fakeRedis } from '../test-utils/fakeRedis.mjs';

const { makeCategory, makeCompleteSeller } = await import('../test-utils/sellerFixtures.mjs');
const { runCouponTick } = await import('../jobs/couponScheduler.js');
const reminders = await import('../services/couponReminders.service.js');
const sms = await import('../services/sms/templateSender.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { generateCouponCode } = await import('../utils/couponCode.js');
const { default: Coupon } = await import('../models/Coupon.js');
const { default: Seller } = await import('../models/Seller.js');
const { default: User } = await import('../models/User.js');
const { default: SmsLog } = await import('../models/SmsLog.js');
const { default: SmsCampaign } = await import('../models/SmsCampaign.js');

let mongo;
let category;
let shop;
let customers;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([Coupon.init(), SmsLog.init(), SmsCampaign.init()]);
});
after(async () => {
  sms.__setSendOverrideForTests(null);
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  __resetCouponSettingsCache();
  sms.__clearMockOutbox();
  sms.__setSendOverrideForTests(null);
  category = await makeCategory({ key: 'salon', name: 'Salon', enabled: true });
  shop = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000001' });
  customers = await User.create(
    Array.from({ length: 8 }, (_, i) => ({ name: `Customer ${i + 1}`, phone: `98111000${String(i + 1).padStart(2, '0')}`, role: 'customer' }))
  );
});

// 20 Nov 2026: 02:10 IST is 19 Nov 20:40 UTC; 10:10 IST is 04:40 UTC.
const AT_0210 = new Date('2026-11-19T20:40:00Z');
const AT_0150 = new Date('2026-11-19T20:20:00Z');
const AT_1010 = new Date('2026-11-20T04:40:00Z');
const NEXT_DAY_1010 = new Date('2026-11-21T04:40:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const credits = (n, sellerId = shop.seller._id) => Seller.updateOne({ _id: sellerId }, { $set: { smsCreditsBalance: n } });
const balance = async (sellerId = shop.seller._id) => (await Seller.findById(sellerId).lean()).smsCreditsBalance;

const coupon = (customer, expiresAt, over = {}) =>
  Coupon.create({
    code: generateCouponCode(),
    kind: 'customer',
    sellerId: shop.seller._id,
    subscriptionId: new mongoose.Types.ObjectId(),
    categoryId: category._id,
    customerId: customer?._id ?? null,
    customerSnapshot: { name: customer?.name ?? null },
    source: { type: 'order', id: new mongoose.Types.ObjectId() },
    issuedAt: new Date('2026-11-01T00:00:00Z'),
    expiresAt,
    ...over,
  });

// ── Expiry ────────────────────────────────────────────────────────────────────

test('expiry: runs from 02:00 IST, once a day; issued past-date coupons expire, nothing else changes', async () => {
  const past = await coupon(customers[0], new Date(AT_0210.getTime() - HOUR));
  const future = await coupon(customers[1], new Date(AT_0210.getTime() + DAY));
  const redeemed = await coupon(customers[2], new Date(AT_0210.getTime() - HOUR), { status: 'redeemed', redeemedAt: new Date('2026-11-10T00:00:00Z') });
  const voided = await coupon(customers[3], new Date(AT_0210.getTime() - HOUR), { status: 'void' });
  const comp = await coupon(null, new Date(AT_0210.getTime() - HOUR), { kind: 'complimentary', source: { type: 'plan', id: new mongoose.Types.ObjectId() } });

  const redis = fakeRedis();
  assert.equal((await runCouponTick({ now: AT_0150, redis })).expiry, 'not_due');
  assert.equal((await Coupon.findById(past._id).lean()).status, 'issued');

  assert.equal((await runCouponTick({ now: AT_0210, redis })).expiry, 'ran');
  const status = async (c) => (await Coupon.findById(c._id).lean()).status;
  assert.equal(await status(past), 'expired');
  assert.equal(await status(comp), 'expired');
  assert.equal(await status(future), 'issued');
  assert.equal(await status(redeemed), 'redeemed');
  assert.equal(await status(voided), 'void');

  assert.equal((await runCouponTick({ now: new Date(AT_0210.getTime() + HOUR), redis })).expiry, 'already_done');
  // Without the marker (another day, a wiped Redis) it is still harmless to run again.
  assert.equal(await reminders.expireDue(AT_0210), 0);
  assert.equal((await runCouponTick({ now: AT_0210, redis: fakeRedis() })).expiry, 'ran');
  assert.equal(await status(redeemed), 'redeemed');
});

test('the lock: a tick while another holds it does nothing; parallel ticks run a job once; no Redis → skipped', async () => {
  await coupon(customers[0], new Date(AT_0210.getTime() - HOUR));
  const redis = fakeRedis();
  await redis.set('lock:coupon:expiry:2026-11-20', 'other-instance', 'EX', 60, 'NX');
  assert.equal((await runCouponTick({ now: AT_0210, redis })).expiry, 'locked');
  assert.equal(await Coupon.countDocuments({ status: 'expired' }), 0);
  await redis.del('lock:coupon:expiry:2026-11-20');

  const results = await Promise.all(Array.from({ length: 5 }, () => runCouponTick({ now: AT_0210, redis })));
  assert.equal(results.filter((r) => r.expiry === 'ran').length, 1, JSON.stringify(results));
  assert.ok(results.every((r) => ['ran', 'locked', 'already_done'].includes(r.expiry)));

  assert.deepEqual(await runCouponTick({ now: AT_1010, redis: null }), { expiry: 'no_redis', reminders: 'no_redis' });
});

// ── Seller reminders ──────────────────────────────────────────────────────────

test('reminders at 10:00 IST: each due coupon once, 1 credit per SMS, phone masked in the mock outbox', async () => {
  await credits(5);
  const due = [
    await coupon(customers[0], new Date(AT_1010.getTime() + 1 * DAY)),
    await coupon(customers[1], new Date(AT_1010.getTime() + 2 * DAY)),
    await coupon(customers[2], new Date(AT_1010.getTime() + 3 * DAY - HOUR)),
  ];
  const tooFar = await coupon(customers[3], new Date(AT_1010.getTime() + 4 * DAY));
  const used = await coupon(customers[4], new Date(AT_1010.getTime() + DAY), { status: 'redeemed', redeemedAt: new Date() });
  const reminded = await coupon(customers[5], new Date(AT_1010.getTime() + DAY), { remindersSent: [{ at: new Date('2026-11-18T00:00:00Z') }] });
  const noPhone = await User.create({ name: 'No Phone', role: 'customer' });
  await coupon(noPhone, new Date(AT_1010.getTime() + DAY));

  const redis = fakeRedis();
  assert.equal((await runCouponTick({ now: new Date('2026-11-20T04:20:00Z'), redis })).reminders, 'not_due', '09:50 IST');
  assert.equal((await runCouponTick({ now: AT_1010, redis })).reminders, 'ran');

  assert.equal(await balance(), 2, '3 SMS, 3 credits');
  const logs = await SmsLog.find().lean();
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((l) => String(l.couponId)).sort(), due.map((c) => String(c._id)).sort());
  assert.ok(logs.every((l) => l.status === 'sent' && l.sentAt && l.providerMessageId));
  for (const c of due) assert.equal((await Coupon.findById(c._id).lean()).remindersSent.length, 1);
  for (const c of [tooFar, used]) assert.equal((await Coupon.findById(c._id).lean()).remindersSent.length, 0);
  assert.equal((await Coupon.findById(reminded._id).lean()).remindersSent.length, 1, 'not reminded again');

  const outbox = sms.__mockOutbox();
  assert.equal(outbox.length, 3);
  assert.deepEqual(outbox.map((m) => m.to).sort(), ['******0001', '******0002', '******0003']);
  assert.ok(!JSON.stringify(outbox).match(/98111000\d\d/), 'no full phone in the outbox');
  assert.equal(outbox[0].vars.business, 'Glow Salon');

  const campaign = await SmsCampaign.findOne({ sellerId: shop.seller._id }).lean();
  assert.equal(campaign.runKey, `seller:${shop.seller._id}:2026-11-20`);
  assert.equal(campaign.status, 'done');
  assert.deepEqual(campaign.counts, { sent: 3, failed: 0 });
  assert.equal(campaign.totalPaise, 3 * 354);

  // Later the same day: done. The next day: the same coupons are never texted again — only the
  // one that has now come within 3 days of its expiry.
  assert.equal((await runCouponTick({ now: new Date(AT_1010.getTime() + HOUR), redis })).reminders, 'already_done');
  assert.equal((await runCouponTick({ now: NEXT_DAY_1010, redis })).reminders, 'ran');
  assert.equal(await SmsLog.countDocuments(), 4);
  assert.equal(await SmsLog.countDocuments({ couponId: tooFar._id }), 1);
  assert.equal(await balance(), 1);
});

test('credits run out: sending stops at zero; topping up sends the rest the next day', async () => {
  await credits(2);
  for (let i = 0; i < 4; i += 1) await coupon(customers[i], new Date(AT_1010.getTime() + (i + 1) * HOUR));
  await runCouponTick({ now: AT_1010, redis: fakeRedis() });
  assert.equal(await balance(), 0);
  assert.equal(await SmsLog.countDocuments({ status: 'sent' }), 2);
  assert.equal(await SmsLog.countDocuments(), 2, 'nothing left claimed for the unpaid ones');
  assert.equal(sms.__mockOutbox().length, 2);

  await credits(10);
  // The two left expire within the lead time of the next day too.
  await Coupon.updateMany({ 'remindersSent.0': { $exists: false } }, { $set: { expiresAt: new Date(NEXT_DAY_1010.getTime() + DAY) } });
  await runCouponTick({ now: NEXT_DAY_1010, redis: fakeRedis() });
  assert.equal(await SmsLog.countDocuments({ status: 'sent' }), 4);
  assert.equal(await balance(), 8);
});

test('no credits → nothing sent, no campaign, nothing debited', async () => {
  for (let i = 0; i < 3; i += 1) await coupon(customers[i], new Date(AT_1010.getTime() + DAY));
  assert.equal((await runCouponTick({ now: AT_1010, redis: fakeRedis() })).reminders, 'ran');
  assert.equal(await SmsLog.countDocuments(), 0);
  assert.equal(await SmsCampaign.countDocuments(), 0);
  assert.equal(sms.__mockOutbox().length, 0);
  assert.equal(await balance(), 0);
});

test('racing runs (e.g. a lost lock): credits debited exactly, never below zero, no coupon texted twice', async () => {
  await credits(3);
  for (let i = 0; i < 6; i += 1) await coupon(customers[i], new Date(AT_1010.getTime() + DAY));
  // Five instances each believe they hold the lock.
  await Promise.all(Array.from({ length: 5 }, () => runCouponTick({ now: AT_1010, redis: fakeRedis() })));
  assert.equal(await balance(), 0);
  assert.equal(await SmsLog.countDocuments({ status: 'sent' }), 3, 'exactly as many SMS as credits');
  const perCoupon = await SmsLog.aggregate([{ $group: { _id: '$couponId', n: { $sum: 1 } } }]);
  assert.ok(perCoupon.every((p) => p.n === 1));
  assert.equal(sms.__mockOutbox().length, 3);
  assert.equal(await SmsCampaign.countDocuments({ sellerId: shop.seller._id }), 1, 'one campaign per seller per day');

  // And with more credits than coupons, parallel runs still send each once.
  await credits(50);
  await Coupon.updateMany({ 'remindersSent.0': { $exists: false } }, { $set: { expiresAt: new Date(NEXT_DAY_1010.getTime() + DAY) } });
  await Promise.all(Array.from({ length: 5 }, () => reminders.runSellerReminders(NEXT_DAY_1010)));
  assert.equal(await SmsLog.countDocuments({ status: 'sent' }), 6);
  assert.equal(await balance(), 47);
});

test('a failed send is logged as failed and its credit given back', async () => {
  await credits(5);
  const a = await coupon(customers[0], new Date(AT_1010.getTime() + DAY));
  const b = await coupon(customers[1], new Date(AT_1010.getTime() + 2 * DAY));
  sms.__setSendOverrideForTests(async (phone) => {
    if (phone.endsWith('01')) throw Object.assign(new Error('DLT template mismatch'), { code: 'PROVIDER_REJECTED' });
    return { provider: 'test', messageId: 'ok-1' };
  });
  await runCouponTick({ now: AT_1010, redis: fakeRedis() });
  assert.equal(await balance(), 4, 'only the delivered SMS is paid for');
  assert.equal((await SmsLog.findOne({ couponId: a._id }).lean()).status, 'failed');
  assert.equal((await SmsLog.findOne({ couponId: a._id }).lean()).error, 'PROVIDER_REJECTED');
  assert.equal((await SmsLog.findOne({ couponId: b._id }).lean()).status, 'sent');
  assert.equal((await Coupon.findById(a._id).lean()).remindersSent.length, 0);
  assert.deepEqual((await SmsCampaign.findOne().lean()).counts, { sent: 1, failed: 1 });
});

// ── Admin campaigns ───────────────────────────────────────────────────────────

test('queued admin campaigns go out at the reminder run, paid by Yulo (no seller credits), each coupon once', async () => {
  const other = await makeCompleteSeller({ status: 'active', categoryId: category._id, phone: '9600000002' });
  const mine = [
    await coupon(customers[0], new Date('2026-11-22T06:00:00Z')),
    await coupon(customers[1], new Date('2026-11-23T06:00:00Z')),
  ];
  await coupon(customers[2], new Date('2026-11-22T06:00:00Z'), { sellerId: other.seller._id });
  await coupon(customers[3], new Date('2026-12-30T06:00:00Z'));
  const campaign = await SmsCampaign.create({
    sellerId: null,
    createdBy: { kind: 'admin', id: new mongoose.Types.ObjectId() },
    filters: { seller: String(shop.seller._id), expiringFrom: '2026-11-21', expiringTo: '2026-11-25' },
    recipientCount: 2,
    unitPricePaise: 300,
    gstPercent: 18,
    status: 'queued',
  });

  const out = await runCouponTick({ now: AT_1010, redis: fakeRedis() });
  assert.equal(out.reminders, 'ran');
  const saved = await SmsCampaign.findById(campaign._id).lean();
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.counts, { sent: 2, failed: 0 });
  assert.deepEqual((await SmsLog.find({ campaignId: campaign._id }).lean()).map((l) => String(l.couponId)).sort(), mine.map((c) => String(c._id)).sort());
  assert.equal(await balance(), 0, 'no seller credits involved');

  // A crash left another one 'sending' half-way: it resumes without re-sending.
  const resumed = await SmsCampaign.create({ ...campaign.toObject(), _id: undefined, status: 'sending', counts: { sent: 1, failed: 0 } });
  await SmsLog.create({ campaignId: resumed._id, couponId: mine[0]._id, phone: customers[0].phone, status: 'sent' });
  await reminders.runAdminCampaigns(AT_1010);
  assert.equal(await SmsLog.countDocuments({ campaignId: resumed._id }), 2);
  assert.equal((await SmsCampaign.findById(resumed._id).lean()).status, 'done');
});
