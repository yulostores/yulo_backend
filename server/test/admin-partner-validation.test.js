// An admin adding or editing a delivery partner: identity and bank fields must be real formats
// (they used to be saved as typed), and are stored normalised.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateTokens } = await import('../services/auth.service.js');
const { default: User } = await import('../models/User.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');

let mongo;
let srv;
let admin;

const base = { fullName: 'QA Rider', email: 'qa-rider@test.local', phone: '9000000091' };
const create = (body) => srv.request('POST', '/api/admin/delivery-partners', { headers: admin, body: { ...base, ...body } });

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
  const user = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  admin = { authorization: `Bearer ${generateTokens(user._id, 'admin').accessToken}` };
});

test('bad Aadhaar, PAN, account number or IFSC is refused, naming the field', async () => {
  for (const [body, field] of [
    [{ aadharNumber: '1234' }, 'aadharNumber'],
    [{ panNumber: 'BADPAN' }, 'panNumber'],
    [{ accountNumber: '12' }, 'bankDetails.accountNumber'],
    [{ ifscCode: 'NOTIFSC' }, 'bankDetails.ifscCode'],
    [{ phone: '12345' }, 'phone'],
  ]) {
    const res = await create(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.details.fieldErrors[field], `${field}: ${JSON.stringify(res.body.details)}`);
  }
  assert.equal(await DeliveryPartner.countDocuments(), 0);
});

test('valid values are accepted and stored normalised', async () => {
  const res = await create({ aadharNumber: '1234 5678 9012', panNumber: 'abcde1234f', accountNumber: '1234 5678 9012', ifscCode: 'hdfc0001234' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const p = await DeliveryPartner.findOne().lean();
  assert.equal(p.aadharNumber, '123456789012');
  assert.equal(p.panNumber, 'ABCDE1234F');
  assert.equal(p.bankDetails.ifscCode, 'HDFC0001234');
});

test('editing is held to the same formats', async () => {
  const { body } = await create({});
  const id = body.data.partner._id;
  const bad = await srv.request('PATCH', `/api/admin/delivery-partners/${id}`, { headers: admin, body: { bankDetails: { ifscCode: 'XX' } } });
  assert.equal(bad.status, 400);
  const ok = await srv.request('PATCH', `/api/admin/delivery-partners/${id}`, { headers: admin, body: { panNumber: 'ABCDE1234F' } });
  assert.equal(ok.status, 200);
});

test('a removed partner no longer counts in the payout summary', async () => {
  const { body } = await create({});
  const id = body.data.partner._id;
  const summary = async () => (await srv.request('GET', '/api/admin/delivery-partners/payouts/summary', { headers: admin })).body.data;
  assert.equal((await summary()).partnersEligible, 1);
  assert.equal((await srv.request('DELETE', `/api/admin/delivery-partners/${id}`, { headers: admin })).status, 200);
  assert.equal((await summary()).partnersEligible, 0);
});

test('a rider saved with an old-format value can still have other fields edited', async () => {
  const { body } = await create({});
  const id = body.data.partner._id;
  await DeliveryPartner.updateOne({ _id: id }, { $set: { aadharNumber: '1234', 'bankDetails.ifscCode': 'OLD' } });
  const res = await srv.request('PATCH', `/api/admin/delivery-partners/${id}`, { headers: admin, body: { fullName: 'Renamed', aadharNumber: '1234', bankDetails: { ifscCode: 'OLD' } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bad = await srv.request('PATCH', `/api/admin/delivery-partners/${id}`, { headers: admin, body: { aadharNumber: '5678' } });
  assert.equal(bad.status, 400);
});
