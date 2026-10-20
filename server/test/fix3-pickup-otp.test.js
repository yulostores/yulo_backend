// The rider's pickup OTP is read to the rider by the restaurant at handover: it appears in the
// owner's and the kitchen's order views only while a rider is assigned and hasn't picked up,
// never to the customer, never to another restaurant — and those views carry no rider pay or
// offer bookkeeping. In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { generateTokens, generateStaffToken } = await import('../services/auth.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: StaffMember } = await import('../models/StaffMember.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');

let mongo;
let srv;
let owner;
let otherOwner;
let customer;
let restaurant;
let otherRestaurant;
let chef;
let rider;
let order;

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
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  otherOwner = await User.create({ name: 'Other', email: 'x@test.local', role: 'restaurant_owner' });
  customer = await User.create({ name: 'Asha', phone: '9876543210', role: 'customer' });
  const base = { location: { type: 'Point', coordinates: [77.59, 12.97] }, isActive: true, approvalStatus: 'active' };
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', ...base });
  otherRestaurant = await Restaurant.create({ ownerId: otherOwner._id, name: 'Elsewhere', ...base });
  chef = await StaffMember.create({ restaurantId: restaurant._id, staffCode: 'C01', name: 'Chef', role: 'chef', phone: '9000000001' });
  rider = await DeliveryPartner.create({ phone: '9111111111', fullName: 'Ravi Kumar', vehicle: { type: '2_wheeler', number: 'KA01AB1234' } });
  order = await Order.create({
    restaurantId: restaurant._id,
    userId: customer._id,
    type: 'delivery',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    status: 'ready',
    paymentMethod: 'online',
    paymentStatus: 'paid',
    deliveryAssignment: {
      partnerId: rider._id,
      status: 'assigned',
      assignedAt: new Date(),
      pickupOtp: '4821',
      offeredTo: rider._id,
      offerStatus: 'accepted',
      earningsBreakdown: { basePay: 20, distancePay: 6.5, tip: 0, distanceKm: 3.3, computedAt: new Date() },
    },
  });
});

const ownerHeaders = (u = owner) => ({ authorization: `Bearer ${generateTokens(u._id, 'restaurant_owner').accessToken}` });
const chefHeaders = () => ({ authorization: `Bearer ${generateStaffToken(chef._id, 'chef', restaurant._id, 0)}` });
const customerHeaders = () => ({ authorization: `Bearer ${generateTokens(customer._id, 'customer').accessToken}` });

const ownerViews = async () => {
  const detail = await srv.get(`/api/owner/${restaurant._id}/orders/${order._id}`, ownerHeaders());
  const list = await srv.get(`/api/owner/${restaurant._id}/orders`, ownerHeaders());
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  return [detail.body.data.order, list.body.data.orders.find((o) => String(o._id) === String(order._id))];
};
const kitchenViews = async () => {
  const detail = await srv.get(`/api/staff/${restaurant._id}/kitchen/orders/${order._id}`, chefHeaders());
  const board = await srv.get(`/api/staff/${restaurant._id}/kitchen/board`, chefHeaders());
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(board.status, 200, JSON.stringify(board.body));
  const all = [...board.body.data.preparing, ...board.body.data.ready, ...board.body.data.completed];
  return [detail.body.data.order, all.find((o) => String(o._id) === String(order._id))];
};

test('owner and kitchen views show the pickup OTP while a rider is assigned and has not picked up', async () => {
  for (const view of [...(await ownerViews()), ...(await kitchenViews())]) {
    const da = view.deliveryAssignment;
    assert.equal(da.pickupOtp, '4821');
    assert.equal(da.status, 'assigned');
    assert.equal(da.partner.name, 'Ravi Kumar');
    assert.equal(da.partner.vehicleNumber, 'KA01AB1234');
    assert.notEqual(da.partner.maskedPhone, '9111111111', 'rider phone is masked');
    for (const key of ['earningsBreakdown', 'offeredTo', 'offerStatus', 'history', 'codCollected']) {
      assert.equal(key in da, false, `no ${key} in the restaurant's view`);
    }
  }
});

test('the OTP is hidden before a rider is assigned and once the food is picked up', async () => {
  await Order.updateOne({ _id: order._id }, { $set: { 'deliveryAssignment.status': 'unassigned', 'deliveryAssignment.partnerId': null } });
  for (const view of [...(await ownerViews()), ...(await kitchenViews())]) assert.equal(view.deliveryAssignment.pickupOtp, null);

  await Order.updateOne(
    { _id: order._id },
    { $set: { 'deliveryAssignment.status': 'picked_up', 'deliveryAssignment.partnerId': rider._id, 'deliveryAssignment.pickupOtpVerifiedAt': new Date(), status: 'out_for_delivery' } }
  );
  for (const view of [...(await ownerViews()), ...(await kitchenViews())]) {
    assert.equal(view.deliveryAssignment.pickupOtp, null);
    assert.ok(view.deliveryAssignment.pickedUpAt);
  }
});

test('the customer never receives the pickup OTP (detail, history) and another restaurant cannot read it', async () => {
  const detail = await srv.get(`/api/orders/${order._id}`, customerHeaders());
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal('pickupOtp' in detail.body.data.order.deliveryAssignment, false);
  assert.equal(JSON.stringify(detail.body).includes('4821'), false);
  const history = await srv.get('/api/orders', customerHeaders());
  assert.equal(history.status, 200);
  assert.equal(JSON.stringify(history.body).includes('4821'), false);
  assert.equal(JSON.stringify(history.body).includes('earningsBreakdown'), false);

  const foreign = await srv.get(`/api/owner/${restaurant._id}/orders/${order._id}`, ownerHeaders(otherOwner));
  assert.equal(foreign.status, 403);
  const viaOwn = await srv.get(`/api/owner/${otherRestaurant._id}/orders/${order._id}`, ownerHeaders(otherOwner));
  assert.equal(viaOwn.status, 404);
});
