// B12 task 5 — payment issues on SupportTicket: owner report / list / detail / reply scoped to
// the owner's restaurant, links validated, YP-YYYYMMDD-NNN numbers, the status flow
// (open → in_review → awaiting_restaurant → in_review → resolved) with its timestamps, admin
// queue / counts / reply / request-information / status change, attachments (stubbed storage),
// redaction, masking, audit log, no-store, a ticket never touching the payout, the legacy
// status vocabulary for customer / rider apps, and the status migration. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const ticketService = await import('../services/supportTicket.service.js');
const { migrateTicketStatuses } = await import('../scripts/migrateTicketStatuses.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: Order } = await import('../models/Order.js');
const { default: SupportTicket } = await import('../models/SupportTicket.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens, generatePartnerTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let admin;
let ownerA;
let ownerB;
let customer;
let restA;
let restB;
let settlementA;
let settlementB;
let uploads;

const h = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const asAdmin = () => h(admin, 'admin');
const asA = () => h(ownerA, 'restaurant_owner');
const asB = () => h(ownerB, 'restaurant_owner');

before(async () => {
  mongo = await startMemoryMongo();
  await SupportTicket.init();
  srv = await startTestServer();
});
after(async () => {
  ticketService.__setTicketUploaderForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  await SupportTicket.syncIndexes();
  uploads = [];
  // Never Cloudinary from a test: record the call and hand back a fake stored file.
  ticketService.__setTicketUploaderForTests(async ({ folder, publicId, resourceType, buffer }) => {
    uploads.push({ folder, publicId, resourceType, bytes: buffer.length });
    return { secureUrl: `https://storage.test/${folder}/${publicId}`, publicId: `${folder}/${publicId}` };
  });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  ownerA = await User.create({ name: 'Owner A', email: 'a@test.local', role: 'restaurant_owner' });
  ownerB = await User.create({ name: 'Owner B', email: 'b@test.local', role: 'restaurant_owner' });
  customer = await User.create({ name: 'Asha', phone: '9876543210', role: 'customer' });
  const restaurant = (owner, name) =>
    Restaurant.create({
      ownerId: owner._id,
      name,
      approvalStatus: 'active',
      isActive: true,
      location: { type: 'Point', coordinates: [77.59, 12.97] },
      payoutAccount: { accountHolderName: name, accountNumberLast4: '4417', ifsc: 'HDFC0001234', status: 'verified' },
    });
  restA = await restaurant(ownerA, 'Annapurna Kitchen');
  restB = await restaurant(ownerB, 'Sagar Dosa Corner');
  const settlement = (r) =>
    RestaurantSettlement.create({
      restaurantId: r._id,
      periodStart: new Date('2026-09-20T18:30:00Z'),
      periodEnd: new Date('2026-09-27T18:29:59.999Z'),
      status: 'paid',
      totals: { netPayable: 198640 },
      payout: { utr: 'UTR123456', paidAt: new Date('2026-10-05T06:00:00Z'), beneficiary: { accountNumberLast4: '4417' } },
    });
  settlementA = await settlement(restA);
  settlementB = await settlement(restB);
});

const report = (fields = {}, headers = asA(), rid = restA._id) =>
  srv.request('POST', `/api/owner/${rid}/payment-issues`, {
    headers,
    body: {
      issueType: 'payout_not_received',
      description: 'The payout for 21–27 Sep is marked paid but I cannot find the credit.',
      contactEmail: 'owner@annapurna.test',
      contactPhone: '+91 98765 40186',
      settlementId: String(settlementA._id),
      ...fields,
    },
  });

const multipart = async (path, headers, fields, file) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('attachment', new Blob([file.bytes], { type: file.type }), file.name);
  const res = await fetch(srv.base + path, { method: 'POST', headers, body: form });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

test('owner reports a payment issue: number, links, linked payout card, masked contact, no-store', async () => {
  const res = await report();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const t = res.body.data.ticket;
  assert.match(t.ticketNumber, /^YP-\d{8}-\d{3}$/);
  assert.equal(t.status, 'open');
  assert.equal(t.issueType, 'payout_not_received');
  assert.equal(t.contact.email, 'owner@annapurna.test');
  assert.doesNotMatch(t.contact.phone, /98765/, 'phone masked');
  assert.deepEqual(
    {
      kind: t.linkedRecord.kind,
      amount: t.linkedRecord.amountPaise,
      transfer: t.linkedRecord.transferStatus,
      last4: t.linkedRecord.last4,
      ref: t.linkedRecord.bankReference,
    },
    { kind: 'payout', amount: 198640, transfer: 'paid', last4: '4417', ref: 'UTR123456' }
  );
  assert.equal(t.progress.reviewedAt, null);

  const second = await report();
  const [, day1, n1] = t.ticketNumber.split('-');
  const [, day2, n2] = second.body.data.ticket.ticketNumber.split('-');
  assert.equal(day1, day2);
  assert.equal(Number(n2), Number(n1) + 1, 'running number per day');
});

test('links must belong to the owner\'s restaurant; a link is required; validation errors', async () => {
  assert.equal((await report({ settlementId: String(settlementB._id) })).status, 404, "another restaurant's payout");
  const otherOrder = await Order.create({
    restaurantId: restB._id,
    type: 'delivery',
    items: [{ menuItemId: restB._id, name: 'Dosa', price: 100, quantity: 1 }],
    subtotal: 100,
  });
  assert.equal((await report({ settlementId: undefined, orderId: String(otherOrder._id) })).status, 404);
  assert.equal((await report({ settlementId: undefined })).status, 400, 'no link at all');
  assert.equal((await report({ issueType: 'refund_me' })).status, 400);
  assert.equal((await report({ contactEmail: 'not-an-email' })).status, 400);
  assert.equal((await report({}, asB(), restA._id)).status, 403, 'owner B on restaurant A');
});

test('owner A never sees owner B\'s tickets', async () => {
  const mine = (await report()).body.data.ticket;
  const theirs = (await report({ settlementId: String(settlementB._id) }, asB(), restB._id)).body.data.ticket;

  const list = await srv.get(`/api/owner/${restA._id}/payment-issues`, asA());
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.tickets.map((t) => t._id), [mine._id]);
  assert.equal(list.body.data.counts.open, 1);

  assert.equal((await srv.get(`/api/owner/${restA._id}/payment-issues/${theirs._id}`, asA())).status, 404);
  assert.equal(
    (await srv.request('POST', `/api/owner/${restA._id}/payment-issues/${theirs._id}/messages`, { headers: asA(), body: { text: 'hi' } })).status,
    404
  );
  assert.equal((await srv.get(`/api/owner/${restB._id}/payment-issues/${theirs._id}`, asA())).status, 403);
});

test('status flow with timestamps; ask-for-information needs a message; owner reply returns to review', async () => {
  const t = (await report()).body.data.ticket;
  const id = t._id;

  // Mark in review.
  let res = await srv.request('PATCH', `/api/admin/tickets/${id}`, { headers: asAdmin(), body: { status: 'in_review' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.ticket.progress.reviewedAt);
  assert.equal(res.body.data.ticket.progress.firstResponseAt, null);

  // Ask for information: message required.
  res = await srv.request('POST', `/api/admin/tickets/${id}/request-information`, { headers: asAdmin(), body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code ?? res.body.code, 'MESSAGE_REQUIRED');
  res = await srv.request('PATCH', `/api/admin/tickets/${id}`, { headers: asAdmin(), body: { status: 'awaiting_restaurant' } });
  assert.equal(res.status, 400, 'awaiting_restaurant only with a message');
  res = await srv.request('POST', `/api/admin/tickets/${id}/request-information`, {
    headers: asAdmin(),
    body: { text: 'Please share the bank statement page for 5 Oct.' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.ticket.status, 'awaiting_restaurant');
  assert.ok(res.body.data.ticket.progress.firstResponseAt);

  const ownerView = (await srv.get(`/api/owner/${restA._id}/payment-issues/${id}`, asA())).body.data.ticket;
  assert.equal(ownerView.status, 'awaiting_restaurant');
  assert.match(ownerView.awaitingInformation, /bank statement page/);
  assert.equal(ownerView.messages[0].from, 'support');
  assert.equal(ownerView.messages[0].requestsInformation, true);
  assert.equal(ownerView.messages[0].sender, undefined, 'no admin user id to the owner');

  // Owner answers → in review.
  res = await srv.request('POST', `/api/owner/${restA._id}/payment-issues/${id}/messages`, {
    headers: asA(),
    body: { text: 'Attached is the statement.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ticket.status, 'in_review');

  // Resolve, with a note.
  res = await srv.request('PATCH', `/api/admin/tickets/${id}`, {
    headers: asAdmin(),
    body: { status: 'resolved', resolutionNote: 'Credit found under UTR123456.' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.ticket.status, 'resolved');
  assert.ok(res.body.data.ticket.progress.resolvedAt);

  // An owner message on a resolved ticket reopens it for review.
  res = await srv.request('POST', `/api/owner/${restA._id}/payment-issues/${id}/messages`, {
    headers: asA(),
    body: { text: 'Still not visible.' },
  });
  assert.equal(res.body.data.ticket.status, 'in_review');
  assert.equal(res.body.data.ticket.progress.resolvedAt, null);

  const actions = (await AdminActivityLog.find({ targetType: 'ticket', targetId: id }).lean()).map((r) => r.action);
  assert.deepEqual(actions.sort(), ['ticket.request_information', 'ticket.update', 'ticket.update'].sort());
});

test('a ticket never changes the payout', async () => {
  const before = await RestaurantSettlement.findById(settlementA._id).lean();
  const t = (await report()).body.data.ticket;
  await srv.request('POST', `/api/admin/tickets/${t._id}/messages`, { headers: asAdmin(), body: { text: 'Checking.' } });
  await srv.request('PATCH', `/api/admin/tickets/${t._id}`, { headers: asAdmin(), body: { status: 'resolved' } });
  const afterwards = await RestaurantSettlement.findById(settlementA._id).lean();
  assert.equal(afterwards.status, before.status);
  assert.deepEqual(afterwards.payout, before.payout);
  assert.equal(afterwards.updatedAt.getTime(), before.updatedAt.getTime());
});

test('admin queue: kind=payment filter, per-status counts, masked phone in the list, full in the detail', async () => {
  const t = (await report()).body.data.ticket;
  await SupportTicket.create({ raisedByType: 'customer', raisedBy: customer._id, subject: 'Late', description: 'Order late', category: 'order_delayed' });

  const all = await srv.get('/api/admin/tickets', asAdmin());
  assert.equal(all.body.data.total, 2, 'Support & Tickets still lists everything');
  const payment = await srv.get('/api/admin/tickets?kind=payment', asAdmin());
  assert.equal(payment.status, 200);
  assert.equal(payment.headers.get('cache-control'), 'no-store');
  assert.equal(payment.body.data.total, 1);
  assert.equal(payment.body.data.counts.open, 1);
  assert.doesNotMatch(payment.body.data.tickets[0].contactPhone, /98765/);
  assert.equal(payment.body.data.tickets[0].linkedRecord.kind, 'payout');

  const counts = await srv.get('/api/admin/tickets/counts?kind=payment', asAdmin());
  assert.deepEqual(counts.body.data.counts, { open: 1, in_review: 0, awaiting_restaurant: 0, resolved: 0 });

  const detail = await srv.get(`/api/admin/tickets/${t._id}`, asAdmin());
  assert.equal(detail.body.data.ticket.contactPhone, '+91 98765 40186');
  assert.equal(detail.body.data.ticket.ticketNumber, t.ticketNumber);

  // The current portal still sends the old vocabulary.
  const legacy = await srv.request('PATCH', `/api/admin/tickets/${t._id}`, { headers: asAdmin(), body: { status: 'in_progress' } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.data.ticket.status, 'in_review');
  const byLegacy = await srv.get('/api/admin/tickets?status=in_progress', asAdmin());
  assert.equal(byLegacy.body.data.total, 1);
});

test('admin ticket detail names the customer and summarises the linked order; the list does not', async () => {
  const order = await Order.collection.insertOne({
    restaurantId: restA._id, userId: customer._id, type: 'delivery', status: 'delivered',
    paymentStatus: 'paid', grandTotal: 321, items: [{ name: 'Butter Naan', quantity: 2, price: 40 }],
    createdAt: new Date(), deliveredAt: new Date(),
  });
  const ticket = await SupportTicket.create({
    raisedByType: 'customer', raisedBy: customer._id, orderId: order.insertedId,
    subject: 'Wrong or missing items', description: 'One naan missing', category: 'wrong_missing_items',
  });
  const detail = (await srv.get(`/api/admin/tickets/${ticket._id}`, asAdmin())).body.data.ticket;
  assert.deepEqual(detail.raisedByUser, { name: 'Asha', phone: '9876543210', email: null });
  assert.equal(detail.order.ref, String(order.insertedId).slice(-6).toUpperCase());
  assert.equal(detail.order.restaurant.name, restA.name);
  assert.equal(detail.order.grandTotal, 321);
  assert.deepEqual(detail.order.items, [{ name: 'Butter Naan', quantity: 2 }]);
  const listed = (await srv.get('/api/admin/tickets', asAdmin())).body.data.tickets.find((x) => String(x._id) === String(ticket._id));
  assert.equal('raisedByUser' in listed, false, 'the list stays light');
});

test('attachments: owner report and admin reply, type and size checked, streamed not linked', async () => {
  const pdf = { bytes: Buffer.from('%PDF-1.4 fake'), type: 'application/pdf', name: 'bank-statement-5-12-oct.pdf' };
  const res = await multipart(
    `/api/owner/${restA._id}/payment-issues`,
    asA(),
    {
      issueType: 'payout_not_received',
      description: 'Payout marked paid but not credited to my account.',
      contactEmail: 'owner@annapurna.test',
      settlementId: String(settlementA._id),
    },
    pdf
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const t = res.body.data.ticket;
  assert.equal(t.attachments.length, 1);
  assert.deepEqual(
    { name: t.attachments[0].name, type: t.attachments[0].mimeType, size: t.attachments[0].size },
    { name: 'bank-statement-5-12-oct.pdf', type: 'application/pdf', size: pdf.bytes.length }
  );
  assert.equal(t.attachments[0].url, undefined, 'no storage URL handed out');
  assert.equal(uploads[0].resourceType, 'raw', 'PDFs stored as raw');

  const webp = await multipart(
    `/api/owner/${restA._id}/payment-issues/${t._id}/messages`,
    asA(),
    { text: 'here' },
    { bytes: Buffer.from('RIFF'), type: 'image/webp', name: 'x.webp' }
  );
  assert.equal(webp.status, 400, 'only PDF / JPG / PNG');

  const reply = await multipart(
    `/api/admin/tickets/${t._id}/messages`,
    asAdmin(),
    { text: 'See the attached confirmation.' },
    { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png', name: 'confirmation.png' }
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const msg = reply.body.data.ticket.messages.at(-1);
  assert.equal(msg.attachments[0].name, 'confirmation.png');
  assert.equal(msg.attachments[0].uploadedByType, 'admin');
  assert.equal(uploads[1].resourceType, 'image');

  const big = await multipart(
    `/api/owner/${restA._id}/payment-issues/${t._id}/messages`,
    asA(),
    { text: 'big' },
    { bytes: Buffer.alloc(5 * 1024 * 1024 + 10), type: 'application/pdf', name: 'big.pdf' }
  );
  assert.equal(big.status, 400, 'over 5 MB');
});

test('redaction: account / card numbers keep their last 4, OTPs are removed, flagged', () => {
  const { text, redacted } = ticketService.redactSensitive(
    'My account 123456789012 and card 4111 1111 1111 1111. OTP is 482913. Amount ₹1,986.40 on 5 Oct 2026.'
  );
  assert.equal(redacted, true);
  assert.doesNotMatch(text, /123456789012|4111 1111 1111 1111|482913/);
  assert.match(text, /•••• 9012/);
  assert.match(text, /•••• 1111/);
  assert.match(text, /OTP is \[removed\]/);
  assert.match(text, /₹1,986\.40 on 5 Oct 2026/, 'amounts and dates untouched');
  assert.equal(ticketService.redactSensitive('Payout for 21–27 Sep not received').redacted, false);
});

test('redaction is applied before storing — report and replies', async () => {
  const t = (await report({ description: 'Paid to 50100123456789 but not received. OTP 1234' })).body.data.ticket;
  const stored = await SupportTicket.findById(t._id).lean();
  assert.doesNotMatch(stored.description, /50100123456789|1234(?!\d)/);
  assert.equal(stored.descriptionRedacted, true);

  await srv.request('POST', `/api/owner/${restA._id}/payment-issues/${t._id}/messages`, {
    headers: asA(),
    body: { text: 'Card 5500 0000 0000 0004' },
  });
  const again = await SupportTicket.findById(t._id).lean();
  assert.equal(again.messages.at(-1).redacted, true);
  assert.doesNotMatch(again.messages.at(-1).text, /5500 0000 0000 0004/);
});

test('linkedTicketsForSettlement lists the payout\'s tickets for the payout detail banner', async () => {
  const t = (await report()).body.data.ticket;
  const rows = await ticketService.linkedTicketsForSettlement(settlementA._id);
  assert.deepEqual(rows.map((r) => [r.ticketNumber, r.status, r.issueType]), [[t.ticketNumber, 'open', 'payout_not_received']]);
  assert.deepEqual(await ticketService.linkedTicketsForSettlement(settlementB._id), []);
});

test('customer and rider apps keep the old status vocabulary', async () => {
  const create = await srv.request('POST', '/api/support/tickets', {
    headers: h(customer, 'customer'),
    body: { category: 'order_delayed', description: 'Where is my food?' },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const id = create.body.data.ticket._id;
  await srv.request('POST', `/api/admin/tickets/${id}/messages`, { headers: asAdmin(), body: { text: 'On it.' } });
  const stored = await SupportTicket.findById(id).lean();
  assert.equal(stored.status, 'in_review', 'stored in the new vocabulary');
  const mine = await srv.get(`/api/support/tickets/${id}`, h(customer, 'customer'));
  assert.equal(mine.body.data.ticket.status, 'in_progress', 'the customer app sees the old one');

  const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');
  const partner = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi' });
  const ph = { authorization: `Bearer ${generatePartnerTokens(partner._id).accessToken}` };
  const pc = await srv.request('POST', '/api/partner/support/tickets', { headers: ph, body: { subject: 'App', description: 'Crash' } });
  assert.equal(pc.status, 201, JSON.stringify(pc.body));
  await SupportTicket.updateOne({ _id: pc.body.data.ticket._id }, { $set: { status: 'awaiting_restaurant' } });
  const pl = await srv.get('/api/partner/support/tickets', ph);
  assert.equal(pl.body.data.rows[0].status, 'in_progress');
});

test('migrateTicketStatuses: dry run writes nothing, apply maps old values, re-run is a no-op', async () => {
  const at = new Date('2026-09-01T00:00:00Z');
  await SupportTicket.collection.insertMany([
    { raisedByType: 'customer', raisedBy: customer._id, subject: 'a', description: 'a', status: 'in_progress', updatedAt: at },
    { raisedByType: 'customer', raisedBy: customer._id, subject: 'b', description: 'b', status: 'closed', updatedAt: at },
    { raisedByType: 'customer', raisedBy: customer._id, subject: 'c', description: 'c', status: 'open', updatedAt: at },
  ]);
  const quiet = () => {};
  assert.deepEqual(await migrateTicketStatuses({ apply: false, log: quiet }), { inProgress: 1, closed: 1, updated: 0 });
  assert.equal(await SupportTicket.collection.countDocuments({ status: 'in_progress' }), 1);

  assert.equal((await migrateTicketStatuses({ apply: true, log: quiet })).updated, 2);
  const closed = await SupportTicket.collection.findOne({ subject: 'b' });
  assert.equal(closed.status, 'resolved');
  assert.equal(closed.resolvedAt.getTime(), at.getTime(), 'resolvedAt falls back to updatedAt');
  assert.equal((await SupportTicket.collection.findOne({ subject: 'a' })).status, 'in_review');
  assert.equal((await migrateTicketStatuses({ apply: true, log: quiet })).updated, 0);
});
