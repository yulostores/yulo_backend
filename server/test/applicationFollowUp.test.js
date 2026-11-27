// The super admin's follow-up on careers entries — job applications and seller applications:
// the Call button (called / not), interested / not interested, the list filters for both, and
// deleting only unpaid entries (hidden, and brought back if the applicant pays anyway).

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { useFakeGatewayEnv, createFakeRazorpay, checkoutSignature, webhookSignature, paymentCapturedEvent } from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { __setClockForTests } = await import('../utils/clock.js');
const auth = await import('../services/auth.service.js');
const { applyLimiter, applyLimiterKey } = await import('../routes/careers.routes.js');
const { default: JobApplication } = await import('../models/JobApplication.js');
const { default: PartnerApplication } = await import('../models/PartnerApplication.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { default: StrayPayment } = await import('../models/StrayPayment.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');
const { default: User } = await import('../models/User.js');

let mongo;
let srv;
let fake;
let adminHeaders;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([JobApplication.init(), PartnerApplication.init(), StrayPayment.init(), WebhookEvent.init()]);
  srv = await startTestServer();
});
after(async () => {
  __setRazorpayForTests(undefined);
  __setClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) await applyLimiter.resetKey(applyLimiterKey(ip));
  __setClockForTests(() => new Date('2026-11-28T06:30:00.000Z'));
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  const admin = await User.create({ name: 'Root', email: 'admin@test.local', role: 'admin' });
  adminHeaders = { authorization: `Bearer ${auth.generateTokens(admin._id, 'admin').accessToken}` };
});

let seq = 0;
const JOB = { fullName: 'Asha Verma', dateOfBirth: '2000-01-01', gender: 'female', city: 'Indore', department: 'restaurant', role: 'waiter', expectedSalaryMin: '12000', expectedSalaryMax: '15000' };
const BIZ = { businessName: 'Glow Salon', category: 'salon', address: '12 MG Road', city: 'Indore', hasGst: true, employees: 4, ownerName: 'Ravi' };

const KINDS = {
  job: {
    base: '/api/admin/job-applications',
    create: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries({ ...JOB, phone: `98765${String(++seq).padStart(5, '0')}` })) form.append(k, v);
      const res = await fetch(`${srv.base}/api/careers/applications`, { method: 'POST', body: form });
      return (await res.json()).data;
    },
    verifyPath: (id) => `/api/careers/applications/${id}/verify`,
    Model: () => JobApplication,
  },
  seller: {
    base: '/api/admin/partner-applications',
    create: async () =>
      (await srv.request('POST', '/api/careers/partner-applications', { body: { ...BIZ, phone: `98765${String(++seq).padStart(5, '0')}` } })).body.data,
    verifyPath: (id) => `/api/careers/partner-applications/${id}/verify`,
    Model: () => PartnerApplication,
  },
};

const pay = async (kind, created) => {
  const payment = fake.addPayment({ id: `pay_fu_${++seq}`, order_id: created.razorpayOrder.id, amount: 10_000, status: 'captured' });
  const res = await srv.request('POST', KINDS[kind].verifyPath(created.application.id), {
    body: { razorpay_order_id: payment.order_id, razorpay_payment_id: payment.id, razorpay_signature: checkoutSignature(payment.order_id, payment.id) },
    headers: { 'x-application-token': created.accessToken },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return payment;
};

for (const kind of Object.keys(KINDS)) {
  const k = KINDS[kind];
  const admin$ = (method, path, body) => srv.request(method, `${k.base}${path}`, { body, headers: adminHeaders });
  const names = async (query = '') => (await admin$('GET', `/${query}`)).body.data.applications.map((a) => a._id);

  test(`${kind}: call marks it called (and can be undone); interested / not interested; filters for both`, async () => {
    const a = (await k.create()).application.id;
    const b = (await k.create()).application.id;
    const c = (await k.create()).application.id;

    const called = await admin$('POST', `/${a}/call`, {});
    assert.equal(called.status, 200, JSON.stringify(called.body));
    assert.equal(called.body.data.application.called, true);
    assert.ok(called.body.data.application.calledAt);
    await admin$('POST', `/${b}/call`, {});
    assert.equal((await admin$('POST', `/${b}/call`, { called: false })).body.data.application.called, false, 'undone');

    assert.equal((await admin$('PATCH', `/${a}/interest`, { interest: 'interested' })).body.data.application.interest, 'interested');
    await admin$('PATCH', `/${b}/interest`, { interest: 'not_interested' });
    await admin$('PATCH', `/${c}/interest`, { interest: 'interested' });
    assert.equal((await admin$('PATCH', `/${c}/interest`, { interest: null })).body.data.application.interest, null, 'cleared');
    assert.equal((await admin$('PATCH', `/${a}/interest`, { interest: 'maybe' })).status, 400);

    assert.deepEqual(await names('?called=yes'), [a]);
    assert.deepEqual((await names('?called=no')).sort(), [b, c].sort());
    assert.deepEqual(await names('?interest=interested'), [a]);
    assert.deepEqual(await names('?interest=not_interested'), [b]);
    assert.deepEqual(await names('?interest=none'), [c]);
    assert.deepEqual(await names('?called=no&interest=not_interested'), [b]);

    const row = (await admin$('GET', '/')).body.data.applications.find((r) => r._id === a);
    assert.equal(row.called, true);
    assert.equal(row.interest, 'interested');
    assert.ok(row.createdAt, 'the list carries the full timestamp');

    const csv = await (await fetch(`${srv.base}${k.base}/export.csv?interest=interested`, { headers: adminHeaders })).text();
    assert.match(csv, /Called,Interest/);
    assert.match(csv, /Yes,Interested/);
  });

  test(`${kind}: only an unpaid entry can be deleted; a late payment brings it back`, async () => {
    const unpaid = await k.create();
    const paid = await k.create();
    await pay(kind, paid);

    const refused = await admin$('DELETE', `/${paid.application.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'ALREADY_PAID');

    const del = await admin$('DELETE', `/${unpaid.application.id}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual(await names(), [paid.application.id], 'hidden from the list');
    assert.equal((await admin$('GET', `/${unpaid.application.id}`)).status, 404);
    assert.equal((await admin$('DELETE', `/${unpaid.application.id}`)).status, 404, 'already gone');
    const counts = (await admin$('GET', '/')).body.data.counts;
    assert.equal(counts.pending_payment, 0, 'not counted');
    assert.equal(await AdminActivityLog.countDocuments({ action: `${kind === 'job' ? 'job' : 'partner'}_application_deleted` }), 1);

    // The applicant pays from a tab left open: the payment lands and the entry is back, paid.
    const payment = fake.addPayment({ id: `pay_late_${++seq}`, order_id: unpaid.razorpayOrder.id, amount: 10_000, status: 'captured' });
    const raw = JSON.stringify(paymentCapturedEvent(payment, 'payment.captured'));
    const hook = await srv.request('POST', '/api/webhooks/razorpay', { raw, headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': `evt_${seq}` } });
    assert.equal(hook.status, 200);
    const back = await k.Model().findById(unpaid.application.id).lean();
    assert.equal(back.payment.status, 'paid');
    assert.equal(back.deletedAt, null);
    assert.equal((await names()).length, 2);
  });
}

test('follow-up routes need an admin', async () => {
  const id = (await KINDS.seller.create()).application.id;
  assert.equal((await srv.request('POST', `/api/admin/partner-applications/${id}/call`, { body: {} })).status, 401);
  assert.equal((await srv.request('DELETE', `/api/admin/job-applications/${id}`)).status, 401);
});
