// Category-wise partner agreements: a super admin publishes an agreement for one business
// category; that category's sellers sign it instead of the general one. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const fx = await import('../test-utils/sellerFixtures.mjs');
const auth = await import('../services/auth.service.js');
const { __resetCouponSettingsCache } = await import('../services/couponSettings.service.js');
const { seedCouponData } = await import('../scripts/seedCouponData.js');
const { default: User } = await import('../models/User.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');

let mongo;
let srv;
let adminH;
let salon;
let spa;
let salonSeller;
let spaSeller;

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
  __resetCouponSettingsCache();
  await seedCouponData({ apply: true, log: () => {} });
  const admin = await User.create({ name: 'Root', email: 'root@test.local', role: 'admin' });
  adminH = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
  salon = await CouponCategory.findOne({ key: 'salon' }).lean();
  spa = await CouponCategory.findOne({ key: 'spa' }).lean();
  salonSeller = await fx.makeCompleteSeller({ status: 'active', categoryId: salon._id, phone: '9000000001' });
  spaSeller = await fx.makeCompleteSeller({ status: 'active', categoryId: spa._id, phone: '9000000002' });
  const general = await srv.request('PUT', '/api/admin/coupon-settings', { headers: adminH, body: { agreementVersion: 1, agreementText: 'General terms v1' } });
  assert.equal(general.status, 200, JSON.stringify(general.body));
});

const view = async (s) => (await srv.get('/api/seller/agreement', s.headers)).body.data.agreement;
const accept = (s, version) => srv.request('POST', '/api/seller/agreement/accept', { headers: s.headers, body: { version } });
const publish = (category, text) => srv.request('PUT', `/api/admin/coupon-categories/${category._id}/agreement`, { headers: adminH, body: { text } });

test('a category agreement replaces the general one for that category only', async () => {
  assert.equal((await accept(salonSeller, 1)).status, 200);
  assert.equal((await view(salonSeller)).upToDate, true, 'signed the general v1');

  const res = await publish(salon, 'Salon partner terms v1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.category.agreement.version, 1);

  const v = await view(salonSeller);
  assert.equal(v.scope, 'category');
  assert.equal(v.categoryName, salon.name);
  assert.equal(v.text, 'Salon partner terms v1');
  assert.equal(v.upToDate, false, 'a general acceptance does not cover the salon agreement');
  assert.equal((await accept(salonSeller, 1)).status, 200);
  assert.equal((await view(salonSeller)).upToDate, true);
  const profile = await srv.get('/api/seller/profile', salonSeller.headers);
  assert.equal(profile.body.data.profile.agreement.upToDate, true);

  // The spa seller still signs the general agreement.
  const spaView = await view(spaSeller);
  assert.equal(spaView.scope, 'general');
  assert.equal(spaView.text, 'General terms v1');

  // A new salon version asks again; accepting an old version is refused.
  assert.equal((await publish(salon, 'Salon partner terms v2')).body.data.category.agreement.version, 2);
  assert.equal((await view(salonSeller)).upToDate, false);
  assert.equal((await accept(salonSeller, 1)).status, 409);
  assert.equal((await accept(salonSeller, 2)).status, 200);

  // Removing it sends the salon's sellers back to the general agreement (to sign again).
  const removed = await publish(salon, '   ');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.data.category.agreement.version, 0);
  const back = await view(salonSeller);
  assert.equal(back.scope, 'general');
  assert.equal(back.upToDate, false);

  const list = await srv.get('/api/admin/coupon-categories', adminH);
  assert.equal(list.body.data.categories.find((c) => c.key === 'salon').agreement.version, 0);
  assert.equal(await AdminActivityLog.countDocuments({ action: 'COUPON_CATEGORY_AGREEMENT_PUBLISHED' }), 2);
  assert.equal(await AdminActivityLog.countDocuments({ action: 'COUPON_CATEGORY_AGREEMENT_REMOVED' }), 1);
});

test('publishing the same text again changes nothing; admins only', async () => {
  await publish(salon, 'Salon terms');
  assert.equal((await publish(salon, 'Salon terms')).status, 400);
  assert.equal((await srv.request('PUT', `/api/admin/coupon-categories/${salon._id}/agreement`, { headers: salonSeller.headers, body: { text: 'x' } })).status, 401);
});
