// The table-QR app's invoice after payment: GET …/tables/:tableId/bill/invoice. Found by the
// Razorpay order the guest paid with; nothing for an unpaid bill or someone else's order id.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: Order } = await import('../models/Order.js');
const { default: Table } = await import('../models/Table.js');
const { default: TableSession } = await import('../models/TableSession.js');
const { default: Bill } = await import('../models/Bill.js');
const { assembleBill } = await import('../services/billing.service.js');

let mongo;
let srv;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer({ withSocket: true });
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

test('paid bill → invoice with items, charge lines and the payment reference', async () => {
  const seed = await seedBasics();
  const table = await Table.create({ restaurantId: seed.restaurant._id, identifier: '9' });
  const session = await TableSession.create({ restaurantId: seed.restaurant._id, tableId: table._id });
  const order = await Order.create({
    restaurantId: seed.restaurant._id, tableSessionId: session._id, tableId: table._id, type: 'dine_in', placedBy: 'guest',
    items: [{ menuItemId: seed.dish._id, name: 'Thali', price: 300, quantity: 2 }], subtotal: 600, status: 'served',
  });
  await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
  const bill = await assembleBill(session._id);
  const url = (q = '') => `/api/restaurants/${seed.restaurant._id}/tables/${table._id}/bill/invoice${q}`;

  assert.equal((await srv.get(url('?razorpayOrderId=order_abc'))).status, 404, 'not paid yet');

  await Bill.updateOne(
    { _id: bill._id },
    { $set: { status: 'paid', paidAt: new Date(), paidBy: 'online', paymentIntentId: 'order_abc', razorpayPaymentId: 'pay_xyz' } }
  );
  const res = await srv.get(url('?razorpayOrderId=order_abc'));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const inv = res.body.data.bill;
  assert.equal(inv.billNumber, bill.billNumber);
  assert.deepEqual(inv.items.map((i) => [i.name, i.quantity, i.lineTotal]), [['Thali', 2, 600]]);
  assert.ok(inv.chargeBreakdown.lines.some((l) => l.key === 'grand_total'));
  assert.equal(inv.payment.transactionId, 'pay_xyz');

  assert.equal((await srv.get(url('?razorpayOrderId=order_someone_else'))).status, 404);
});
