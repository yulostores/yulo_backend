// Rider app fixes found while testing the delivery partner app end to end on a phone:
//  - a cash deposit can't be larger than the cash the rider holds (it used to be accepted and
//    silently wrote off the next cash they collected);
//  - a rider must be 18 or older (the date of birth could be today);
//  - submitting for review needs the vehicle model and registration (non-RTO EVs have none).
// In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generatePartnerTokens } = await import('../services/auth.service.js');
const { getCashInHand } = await import('../services/cashLedger.service.js');
const { __resetFinanceSettingsCache } = await import('../services/financeSettings.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
const { default: CashDeposit } = await import('../models/CashDeposit.js');

let mongo;
let srv;
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
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [77.59, 12.97] } });
});

const headers = (partner) => ({ authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` });

// A cash order this rider delivered, with `codCollected` rupees in hand.
const deliveredCash = (partner, codCollected) =>
  Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'delivered',
    paymentMethod: 'cash',
    items: [{ menuItemId: restaurant._id, name: 'Paneer Tikka', price: codCollected, quantity: 1 }],
    subtotal: codCollected,
    grandTotal: codCollected,
    deliveryAssignment: { partnerId: partner._id, status: 'delivered', codCollected },
  });

test('a cash deposit is refused when it is more than the cash the rider holds', async () => {
  const rider = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi', verificationStatus: 'approved' });
  await deliveredCash(rider, 316);

  const tooMuch = await srv.request('POST', '/api/partner/deposits', { body: { amount: 100000 }, headers: headers(rider) });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.body.code, 'AMOUNT_EXCEEDS_CASH_IN_HAND');
  assert.equal(await CashDeposit.countDocuments(), 0, 'nothing recorded');
  assert.equal(await getCashInHand(rider._id), 316, 'still owed');

  // The full amount (and a part of it) still go through.
  const part = await srv.request('POST', '/api/partner/deposits', { body: { amount: 100 }, headers: headers(rider) });
  assert.equal(part.status, 201);
  const rest = await srv.request('POST', '/api/partner/deposits', { body: { amount: 216 }, headers: headers(rider) });
  assert.equal(rest.status, 201);
  assert.equal(rest.body.data.cashInHand, 0);

  // A later cash delivery is owed in full — no credit left over to hide it.
  await deliveredCash(rider, 250);
  assert.equal(await getCashInHand(rider._id), 250);
  const again = await srv.request('POST', '/api/partner/deposits', { body: { amount: 251 }, headers: headers(rider) });
  assert.equal(again.status, 400);
});

test('a rider must be at least 18: a later date of birth is refused with the reason', async () => {
  const rider = await DeliveryPartner.create({ phone: '9111111112' });
  const tooYoung = new Date();
  tooYoung.setUTCFullYear(tooYoung.getUTCFullYear() - 17);
  const refused = await srv.request('PATCH', '/api/partner/onboarding/personal', {
    body: { fullName: 'Ravi Kumar', dateOfBirth: tooYoung.toISOString().slice(0, 10) },
    headers: headers(rider),
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /at least 18/);
  assert.equal((await DeliveryPartner.findById(rider._id).lean()).fullName, undefined, 'nothing saved');

  const ok = await srv.request('PATCH', '/api/partner/onboarding/personal', {
    body: { fullName: 'Ravi Kumar', dateOfBirth: '2001-10-15' },
    headers: headers(rider),
  });
  assert.equal(ok.status, 200);
});

test('submitting for review needs the vehicle model and registration — except a non-RTO EV', async () => {
  const documents = ['aadhar_card', 'driving_license', 'vehicle_rc', 'insurance_document', 'profile_photo'].map((type) => ({
    type,
    url: `https://example.test/${type}.jpg`,
    status: 'pending',
  }));
  const rider = await DeliveryPartner.create({
    phone: '9111111113',
    fullName: 'Ravi Kumar',
    documents,
    bankDetails: { accountNumber: '12345678901', ifscCode: 'SBIN0001234' },
    vehicle: { type: '2_wheeler', model: '', number: '' },
  });
  const submit = () => srv.request('POST', '/api/partner/onboarding/submit', { headers: headers(rider) });

  const missing = await submit();
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'INCOMPLETE_ONBOARDING');
  assert.deepEqual(missing.body.details.missing, ['vehicle.model', 'vehicle.number']);

  // A low-speed EV has no registration: the model is enough.
  await DeliveryPartner.updateOne({ _id: rider._id }, { $set: { 'vehicle.type': 'non_rto_2_wheeler', 'vehicle.model': 'Yulu Miracle' } });
  const ev = await submit();
  assert.equal(ev.status, 200);
  assert.equal(ev.body.data.partner.verificationStatus, 'under_review');
});
