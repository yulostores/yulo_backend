// B1 — dine-in bill paid online through the public (QR) endpoints: the Razorpay order is
// created for the exact bill amount, a payment for any other amount is refused, the webhook
// settles a bill the guest's device never confirmed, and a gateway failure never locks the
// table. Fake Razorpay, in-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import {
  useFakeGatewayEnv,
  createFakeRazorpay,
  checkoutSignature,
  webhookSignature,
  paymentCapturedEvent,
  seedBasics,
} from '../test-utils/paymentFixtures.mjs';

useFakeGatewayEnv();

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { __setRazorpayForTests } = await import('../services/razorpayClient.js');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { default: WebhookEvent } = await import('../models/WebhookEvent.js');

let mongo;
let srv;
let fake;
let seed;
let table;
let session;

before(async () => {
  mongo = await startMemoryMongo();
  await WebhookEvent.init();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  __setRazorpayForTests(undefined);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  fake = createFakeRazorpay();
  __setRazorpayForTests(fake);
  seed = await seedBasics();
  table = await Table.create({ restaurantId: seed.restaurant._id, identifier: 'T4' });
  session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const order = await Order.create({
    restaurantId: seed.restaurant._id,
    tableSessionId: session._id,
    tableId: table._id,
    type: 'dine_in',
    placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
});

const base = () => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill`;

const startPayment = async () => {
  const res = await srv.request('POST', `${base()}/pay`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};

test('pay: Razorpay order for exactly the bill total; amount stamped on the bill; table locked', async () => {
  const { razorpayOrder } = await startPayment();
  const bill = await Bill.findOne({ tableSessionId: session._id }).select('+razorpayFee +razorpayTax +financials').lean();

  assert.equal(razorpayOrder.amount, Math.round(bill.grandTotal * 100));
  assert.equal(bill.paymentAmountPaise, razorpayOrder.amount);
  assert.equal(bill.paymentIntentId, razorpayOrder.id);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'bill_requested');
});

test('verify: correct payment settles the bill online and stores the gateway fee', async () => {
  const { razorpayOrder } = await startPayment();
  fake.addPayment({ id: 'pay_b1', order_id: razorpayOrder.id, amount: razorpayOrder.amount, fee: 700, tax: 107 });

  const res = await srv.request('POST', `${base()}/verify`, {
    body: {
      razorpay_payment_id: 'pay_b1',
      razorpay_order_id: razorpayOrder.id,
      razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_b1'),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const bill = await Bill.findOne({ tableSessionId: session._id }).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(bill.status, 'paid');
  assert.equal(bill.paymentChannel, 'online');
  assert.equal(bill.razorpayFee, 700);
  assert.equal(bill.razorpayTax, 107);
  const order = await Order.findOne({ tableSessionId: session._id }).lean();
  assert.equal(order.paymentChannel, 'online');
});

test('verify: wrong amount → refused, bill stays open, refund flagged, table reopened', async () => {
  const { razorpayOrder } = await startPayment();
  fake.addPayment({ id: 'pay_b2', order_id: razorpayOrder.id, amount: 1000 });

  const res = await srv.request('POST', `${base()}/verify`, {
    body: {
      razorpay_payment_id: 'pay_b2',
      razorpay_order_id: razorpayOrder.id,
      razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_b2'),
    },
  });
  assert.equal(res.status, 400);

  const bill = await Bill.findOne({ tableSessionId: session._id }).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(bill.status, 'open');
  assert.equal(bill.refundStatus, 'pending');
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
});

test('verify: gateway unreachable → 502 and the table stays locked (payment may have succeeded)', async () => {
  const { razorpayOrder } = await startPayment();
  fake.addPayment({ id: 'pay_b3', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  fake.failNextFetch(new Error('ETIMEDOUT'));

  const res = await srv.request('POST', `${base()}/verify`, {
    body: {
      razorpay_payment_id: 'pay_b3',
      razorpay_order_id: razorpayOrder.id,
      razorpay_signature: checkoutSignature(razorpayOrder.id, 'pay_b3'),
    },
  });
  assert.equal(res.status, 502);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'bill_requested');
});

test('webhook settles a bill the guest device never confirmed', async () => {
  const { razorpayOrder } = await startPayment();
  const payment = fake.addPayment({ id: 'pay_b4', order_id: razorpayOrder.id, amount: razorpayOrder.amount });
  const raw = JSON.stringify(paymentCapturedEvent(payment));

  const res = await srv.request('POST', '/api/webhooks/razorpay', {
    raw,
    headers: { 'x-razorpay-signature': webhookSignature(raw), 'x-razorpay-event-id': 'evt_bill' },
  });
  assert.equal(res.status, 200);
  const bill = await Bill.findOne({ tableSessionId: session._id }).select('+razorpayFee +razorpayTax +financials').lean();
  assert.equal(bill.status, 'paid');
  assert.equal(bill.razorpayPaymentId, 'pay_b4');
});

test('pay: gateway error → 502 and the table is NOT locked', async () => {
  fake.orders.create = async () => {
    throw { statusCode: 500, error: { description: 'Razorpay down' } };
  };
  const res = await srv.request('POST', `${base()}/pay`);
  assert.equal(res.status, 502);
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
});

test('pay: no gateway configured → 503 and the table is NOT locked', async () => {
  __setRazorpayForTests(null);
  const res = await srv.request('POST', `${base()}/pay`);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'PAYMENT_GATEWAY_UNAVAILABLE');
  assert.equal((await TableSession.findById(session._id).lean()).status, 'open');
});
