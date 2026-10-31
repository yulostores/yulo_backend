// The rider's offer carries pickup and delivery ETAs from the same straight-line estimate the
// customer's tracking uses, instead of null ("ETA · —" on every order). In-memory MongoDB.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { buildOfferPayload } = await import('../services/deliveryAssignment.service.js');
const { estimateEtaMinutes } = await import('../services/geo.service.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Order } = await import('../models/Order.js');
const { default: DeliveryPartner } = await import('../models/DeliveryPartner.js');

let mongo;
let restaurant;
let order;

before(async () => {
  mongo = await startMemoryMongo();
});
after(async () => {
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  const owner = await User.create({ name: 'O', email: 'o@test.local', role: 'restaurant_owner' });
  restaurant = await Restaurant.create({ ownerId: owner._id, name: 'Spice Route', location: { type: 'Point', coordinates: [73.7795, 18.5625] } });
  order = await Order.create({
    restaurantId: restaurant._id,
    type: 'delivery',
    status: 'confirmed',
    items: [{ menuItemId: restaurant._id, name: 'Thali', price: 300, quantity: 1 }],
    subtotal: 300,
    paymentMethod: 'online',
    paymentStatus: 'paid',
    deliveryAddress: { street: 'Baner Road', city: 'Pune', coordinates: [73.788, 18.5599] },
  });
});

test('a rider with a fresh ping gets both ETAs, matching the customer-side estimate', async () => {
  const rider = await DeliveryPartner.create({
    phone: '9000000002',
    currentLocation: { type: 'Point', coordinates: [73.7799, 18.5628] },
    currentLocationUpdatedAt: new Date(),
  });
  const offer = await buildOfferPayload(order.toObject(), rider.toObject());
  assert.ok(offer.dropKm > 0 && offer.pickupKm != null);
  assert.equal(offer.customerEtaMin, estimateEtaMinutes(offer.dropKm));
  assert.equal(offer.pickupEtaMin, estimateEtaMinutes(offer.pickupKm));
  assert.ok(offer.customerEtaMin >= 1);
});

test('a rider whose location is stale gets no pickup ETA — never one from an old position', async () => {
  const rider = await DeliveryPartner.create({
    phone: '9000000002',
    currentLocation: { type: 'Point', coordinates: [73.7799, 18.5628] },
    currentLocationUpdatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  const offer = await buildOfferPayload(order.toObject(), rider.toObject());
  assert.equal(offer.pickupKm, null);
  assert.equal(offer.pickupEtaMin, null);
  assert.equal(offer.customerEtaMin, estimateEtaMinutes(offer.dropKm));
});
