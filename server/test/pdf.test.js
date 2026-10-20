// PDF downloads: the owner's weekly statement and order/bill payment statements, the admin's
// statement (with the platform figures) and the paid payout's receipt. Each is a real PDF with
// the same numbers as the screen it mirrors; owner PDFs never carry Razorpay's fee, Yulo's
// margin, rider pay or the staff hold note; scoping matches the JSON endpoints. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __resetFinanceSettingsCache, getActiveSettings } = await import('../services/financeSettings.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');
const { computeCustomerCharges } = await import('../services/charges.service.js');
const { computeRestaurantSettlementLine } = await import('../services/settlementMath.service.js');
const settlementService = await import('../services/settlement.service.js');
const pdfs = await import('../services/pdf/statements.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: RestaurantLedgerEntry } = await import('../models/RestaurantLedgerEntry.js');
const { default: RestaurantSettlement } = await import('../models/RestaurantSettlement.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const { generateTokens } = await import('../services/auth.service.js');

const WEEK = new Date('2026-10-07T06:00:00Z'); // inside the IST week Mon 5 – Sun 11 Oct 2026
const CLOCK = new Date('2026-10-20T06:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const OWNER_FORBIDDEN = [/razorpay fee/i, /margin/i, /rider pay/i, /INTERNAL-NOTE-SECRET/, /internal note/i];

let mongo;
let srv;
let owner;
let otherOwner;
let admin;
let restaurant;
let settings;
let statementId;
const ids = {};

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([RestaurantLedgerEntry.init(), RestaurantSettlement.init()]);
  srv = await startTestServer();
});
after(async () => {
  settlementService.__setSettlementClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});

const account = (last4) => ({
  accountHolderName: 'Annapurna Kitchen',
  accountNumberEncrypted: encryptField(`12345678${last4}`),
  accountNumberLast4: last4,
  ifsc: 'HDFC0001234',
  accountType: 'current',
  status: 'verified',
  submittedAt: new Date('2026-09-01T00:00:00Z'),
  verifiedAt: new Date('2026-09-02T00:00:00Z'),
});

// PDF case 1 exactly: ₹357 = 315 food + ₹30 delivery (25.42 + 4.58) + ₹12 fee → net ₹302.50.
const case1Charges = () => {
  const c = computeCustomerCharges({ orderType: 'delivery', foodSubtotalPaise: 30000, restaurant: { gstRegistered: true, delivery: {} }, distanceKm: 1, settings });
  const delivery = { ...c.delivery, base: 2542, gst: 458, total: 3000, customerPays: 3000 };
  return { ...c, delivery, roundOff: 0, grandTotal: 35700, lines: c.lines.map((l) => (l.key === 'grand_total' ? { ...l, amountPaise: 35700 } : l)) };
};

beforeEach(async () => {
  await mongo.clear();
  __resetFinanceSettingsCache();
  settlementService.__setSettlementClockForTests(() => CLOCK);
  settings = await getActiveSettings();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'Other', email: 'x@test.local', role: 'restaurant_owner' });
  admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
  restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Annapurna Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    approvalStatus: 'active',
    gstRegistered: true,
    payoutAccount: account('4417'),
  });
  ids.other = (
    await Restaurant.create({
      ownerId: otherOwner._id,
      name: 'Other Kitchen',
      location: { type: 'Point', coordinates: [77.6, 12.98] },
      approvalStatus: 'active',
      payoutAccount: account('9012'),
    })
  )._id;

  const charges = case1Charges();
  const order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    charges,
    paymentMethod: 'online',
    paymentChannel: 'online',
    paymentStatus: 'paid',
    paymentAmountPaise: 35700,
    razorpayFee: 1138,
    razorpayTax: 174,
    status: 'delivered',
    deliveredAt: WEEK,
  });
  const line = computeRestaurantSettlementLine({ charges, paymentChannel: 'online', razorpayFeePaise: 1138, razorpayTaxPaise: 174, riderPayPaise: 2000, settings });
  await RestaurantLedgerEntry.create({ restaurantId: restaurant._id, type: 'order_earning', direction: 'credit', amountPaise: line.restaurantNet, orderId: order._id, breakdown: line, eligibleAt: WEEK, clearsAt: WEEK });
  ids.order = order._id;

  // Case 4: a dine-in bill paid at the counter (−₹12.42).
  const dc = computeCustomerCharges({ orderType: 'dine_in', foodSubtotalPaise: 30000, restaurant: { gstRegistered: true }, settings });
  const bill = await Bill.create({
    restaurantId: restaurant._id,
    type: 'dine_in',
    billNumber: 'B-0002',
    tableNumber: '6',
    subtotal: 300,
    grandTotal: dc.grandTotal / 100,
    charges: dc,
    status: 'paid',
    paidAt: WEEK,
    paidBy: 'upi',
    paymentChannel: 'counter',
  });
  const counterLine = computeRestaurantSettlementLine({ charges: dc, paymentChannel: 'counter', settings });
  await RestaurantLedgerEntry.create({ restaurantId: restaurant._id, type: 'counter_platform_fee', direction: 'debit', amountPaise: -counterLine.restaurantNet, billId: bill._id, breakdown: counterLine, eligibleAt: WEEK, clearsAt: WEEK });
  ids.bill = bill._id;

  await settlementService.generateWeeklySettlements(WEEK);
  statementId = (await RestaurantSettlement.findOne({ restaurantId: restaurant._id }).lean())._id;
});

const auth = (user, role) => ({ authorization: `Bearer ${generateTokens(user._id, role).accessToken}` });
const fetchPdf = async (path, headers) => {
  const res = await fetch(srv.base + path, { headers });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buffer, headers: res.headers, json: res.headers.get('content-type')?.includes('json') ? JSON.parse(buffer.toString()) : null };
};
const assertPdf = (res, filenamePrefix) => {
  assert.equal(res.status, 200, res.json ? JSON.stringify(res.json) : '');
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-disposition'), new RegExp(`^attachment; filename="${filenamePrefix}[a-z0-9-]*\\.pdf"$`));
  assert.equal(res.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(res.buffer.length > 2000);
};
const NET = 30250 - 1242; // ₹290.08

test('owner statement PDF: the screen\'s numbers, ₹ signs, no platform figures', async () => {
  const res = await fetchPdf(`/api/owner/${restaurant._id}/settlements/${statementId}/pdf`, auth(owner, 'restaurant_owner'));
  assertPdf(res, 'yulo-statement-annapurna-kitchen-');

  const { text } = await pdfs.ownerStatementPdf(restaurant._id, statementId);
  assert.match(text, /₹290\.08/, 'the net payout');
  assert.match(text, /Net payout/);
  assert.match(text, /Food incl\. GST/);
  assert.match(text, /₹302\.50/, 'the delivery order row');
  assert.match(text, /−₹12\.42/, 'the counter bill row');
  assert.match(text, /Bank account ending 4417/);
  assert.match(text, /Generated .* IST/);
  for (const bad of OWNER_FORBIDDEN) assert.doesNotMatch(text, bad);
  assert.equal(NET, 29008);
});

test('owner order and bill PDFs: customer bill, settlement fee split, received amount', async () => {
  const order = await fetchPdf(`/api/owner/${restaurant._id}/payments/orders/${ids.order}/pdf`, auth(owner, 'restaurant_owner'));
  assertPdf(order, 'yulo-order-');
  const bill = await fetchPdf(`/api/owner/${restaurant._id}/payments/bills/${ids.bill}/pdf`, auth(owner, 'restaurant_owner'));
  assertPdf(bill, 'yulo-bill-b-0002-');

  const o = (await pdfs.ownerPaymentPdf(restaurant._id, 'order', ids.order)).text;
  assert.match(o, /Paid amount[\s\S]*₹357\.00/);
  assert.match(o, /3\.5% of ₹357\.00 · ₹10\.59 \+ ₹1\.91 GST/);
  assert.match(o, /Received amount[\s\S]*₹302\.50/);
  for (const bad of OWNER_FORBIDDEN) assert.doesNotMatch(o, bad);

  const b = (await pdfs.ownerPaymentPdf(restaurant._id, 'bill', ids.bill)).text;
  assert.match(b, /Paid at the restaurant/);
  assert.match(b, /Received amount[\s\S]*−₹12\.42/);
});

test('owner scoping: another owner gets 403 on the restaurant, 404 for foreign ids on their own', async () => {
  const other = auth(otherOwner, 'restaurant_owner');
  assert.equal((await fetchPdf(`/api/owner/${restaurant._id}/settlements/${statementId}/pdf`, other)).status, 403);
  assert.equal((await fetchPdf(`/api/owner/${ids.other}/settlements/${statementId}/pdf`, other)).status, 404);
  assert.equal((await fetchPdf(`/api/owner/${ids.other}/payments/orders/${ids.order}/pdf`, other)).status, 404);
  assert.equal((await fetchPdf(`/api/owner/${ids.other}/payments/bills/${ids.bill}/pdf`, other)).status, 404);
  assert.equal((await fetchPdf(`/api/owner/${restaurant._id}/settlements/${statementId}/pdf`)).status, 401);
});

test('admin statement PDF has the platform figures and the hold note; downloads are audit-logged', async () => {
  await settlementService.holdSettlement(statementId, admin._id, { reason: 'dispute_review', note: 'INTERNAL-NOTE-SECRET check with ops' });
  const res = await fetchPdf(`/api/admin/finance/payouts/${statementId}/pdf`, auth(admin, 'admin'));
  assertPdf(res, 'yulo-admin-statement-annapurna-kitchen-');
  const { text } = await pdfs.adminStatementPdf(statementId);
  assert.match(text, /Razorpay fees \(actual\)[\s\S]*₹11\.38/);
  assert.match(text, /Yulo margin on settlement charge[\s\S]*₹1\.54/, "1.12 on the delivery + 0.42 on the counter bill");
  assert.match(text, /Rider pay[\s\S]*₹20\.00/);
  assert.match(text, /INTERNAL-NOTE-SECRET/);
  assert.equal(await AdminActivityLog.countDocuments({ action: 'payout.statement_pdf', targetId: statementId }), 1);

  // …and the owner's statement of the same held payout still doesn't carry the note.
  const ownerText = (await pdfs.ownerStatementPdf(restaurant._id, statementId)).text;
  assert.doesNotMatch(ownerText, /INTERNAL-NOTE-SECRET/);

  assert.equal((await fetchPdf(`/api/admin/finance/payouts/${statementId}/pdf`, auth(owner, 'restaurant_owner'))).status, 403);
});

test('payout receipt: 409 NOT_PAID until paid, then the bank reference and amount', async () => {
  const before = await fetchPdf(`/api/admin/finance/payouts/${statementId}/receipt.pdf`, auth(admin, 'admin'));
  assert.equal(before.status, 409);
  assert.equal(before.json.code ?? before.json.error?.code, 'NOT_PAID');

  await settlementService.scheduleSettlement(statementId, { scheduledFor: new Date(CLOCK.getTime() + DAY) }, admin._id);
  await settlementService.releaseSettlement(statementId, admin._id);
  await settlementService.markPaidManually(statementId, 'UTR-PDF-0001', admin._id);

  const res = await fetchPdf(`/api/admin/finance/payouts/${statementId}/receipt.pdf`, auth(admin, 'admin'));
  assertPdf(res, 'yulo-payout-receipt-annapurna-kitchen-');
  const { text } = await pdfs.payoutReceiptPdf(statementId);
  assert.match(text, /Amount paid[\s\S]*₹290\.08/);
  assert.match(text, /UTR-PDF-0001/);
  assert.match(text, /Bank account ending 4417/);
  assert.match(text, /Recorded by[\s\S]*Yulo Stores/);
  assert.doesNotMatch(text, /Admin/);
  assert.equal(await AdminActivityLog.countDocuments({ action: 'payout.receipt_pdf', targetId: statementId }), 1);

  // The owner's statement now shows Paid with the reference.
  const ownerText = (await pdfs.ownerStatementPdf(restaurant._id, statementId)).text;
  assert.match(ownerText, /UTR-PDF-0001/);
});
