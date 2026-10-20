// B3 — the pricing engine (services/charges.service.js), pure: the PDF's cases to the paisa,
// GST registration, delivery distance rounding and minimum, free delivery, discounts,
// round-off, dine-in platform-fee counts, display lines, and the delivery-zone checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCustomerCharges,
  resolveDeliveryDistance,
  toLegacyTotals,
} from '../services/charges.service.js';

// Business defaults, except a per-km rate that turns 1 km into exactly the PDF's ₹25.42
// delivery base — the PDF's ₹30 delivery isn't a distance the ₹8/km rate can produce.
const SETTINGS = Object.freeze({
  _id: 'settings-v1',
  version: 1,
  foodGstPercent: 5,
  serviceGstPercent: 18,
  customerPlatformFee: 1200,
  deliveryPerKmRate: 2542,
  deliveryMinCharge: 0,
  deliveryDistanceRounding: 0.1,
});
const GST_RESTAURANT = { gstRegistered: true, delivery: {} };

const price = (overrides) =>
  computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant: GST_RESTAURANT,
    distanceKm: 1,
    settings: SETTINGS,
    ...overrides,
  });

test('PDF Case 1 — delivery: ₹300 food + ₹15 GST + ₹30 delivery + ₹12 platform = ₹357', () => {
  const c = price();
  assert.deepEqual(c.food, { subtotal: 30000, discount: 0, base: 30000, gstPercent: 5, gst: 1500, total: 31500 });
  assert.equal(c.delivery.base, 2542);
  assert.equal(c.delivery.gst, 458);
  assert.equal(c.delivery.total, 3000);
  assert.equal(c.delivery.paidBy, 'customer');
  assert.equal(c.delivery.customerPays, 3000);
  assert.deepEqual(c.platformFee, { count: 1, base: 1017, gst: 183, total: 1200 });
  assert.equal(c.food.gst + c.delivery.gst + c.platformFee.gst, 2141, 'GST ₹21.41 as in the PDF');
  assert.equal(c.roundOff, 0);
  assert.equal(c.grandTotal, 35700);
  assert.equal(c.settingsVersionId, 'settings-v1');
});

test('PDF Case 2 — free delivery: customer pays ₹327, restaurant bears the ₹30', () => {
  const c = price({ restaurant: { gstRegistered: true, delivery: { freeThreshold: 299 } } });
  assert.equal(c.delivery.paidBy, 'restaurant');
  assert.equal(c.delivery.customerPays, 0);
  assert.equal(c.delivery.total, 3000, 'the charge still exists — the restaurant pays it');
  assert.equal(c.food.gst + c.platformFee.gst, 1683, 'GST ₹16.83 as in the PDF');
  assert.equal(c.grandTotal, 32700);
  const line = c.lines.find((l) => l.key === 'delivery_fee');
  assert.equal(line.amountPaise, 0);
  assert.equal(line.sublabel, 'Free delivery');
});

test('free-delivery threshold not met → customer pays delivery', () => {
  const c = price({ restaurant: { gstRegistered: true, delivery: { freeThreshold: 500 } } });
  assert.equal(c.delivery.paidBy, 'customer');
  assert.equal(c.grandTotal, 35700);
});

test('PDF Case 3 — dine-in: ₹300 + ₹15 GST + ₹12 platform = ₹327, no delivery', () => {
  const c = price({ orderType: 'dine_in', distanceKm: null });
  assert.equal(c.delivery, null);
  assert.equal(c.grandTotal, 32700);
  assert.ok(!c.lines.some((l) => l.key === 'delivery_fee'));
});

test('takeaway has a platform fee and no delivery', () => {
  const c = price({ orderType: 'takeaway', distanceKm: null });
  assert.equal(c.delivery, null);
  assert.equal(c.grandTotal, 32700);
});

test('non-GST-registered restaurant → no food GST, no GST line', () => {
  const c = price({ restaurant: { gstRegistered: false, delivery: {} } });
  assert.equal(c.food.gstPercent, 0);
  assert.equal(c.food.gst, 0);
  assert.equal(c.grandTotal, 34200);
  assert.ok(!c.lines.some((l) => l.key === 'food_gst'));
});

test('delivery distance is rounded UP to the configured step, then priced per km + 18 % GST', () => {
  const settings = { ...SETTINGS, deliveryPerKmRate: 800 }; // ₹8/km
  const at = (km) => price({ distanceKm: km, settings }).delivery;
  assert.equal(at(3.14).distanceKm, 3.2);
  assert.equal(at(3.2).distanceKm, 3.2, 'an exact multiple is not bumped (no float drift)');
  assert.equal(at(0.01).distanceKm, 0.1);
  const d = at(3.14);
  assert.equal(d.base, 2560); // 3.2 km × ₹8
  assert.equal(d.gst, 461); // 18 % of ₹25.60 = 4.608 → 4.61
  assert.equal(d.total, 3021);

  const halfKm = price({ distanceKm: 3.14, settings: { ...settings, deliveryDistanceRounding: 0.5 } }).delivery;
  assert.equal(halfKm.distanceKm, 3.5);
});

test('delivery minimum charge applies to short trips', () => {
  const settings = { ...SETTINGS, deliveryPerKmRate: 800, deliveryMinCharge: 2000 };
  assert.equal(price({ distanceKm: 0.5, settings }).delivery.base, 2000);
  assert.equal(price({ distanceKm: 3, settings }).delivery.base, 2400);
});

test('round-off line appears when the total has paise, and the total lands on a whole rupee', () => {
  const settings = { ...SETTINGS, deliveryPerKmRate: 800 };
  const c = price({ distanceKm: 3.14, settings }); // 31500 + 3021 + 1200 = 35721
  assert.equal(c.subtotalBeforeRoundOff, 35721);
  assert.equal(c.roundOff, -21);
  assert.equal(c.grandTotal, 35700);
  assert.equal(c.grandTotal % 100, 0);
  assert.deepEqual(c.lines.find((l) => l.key === 'round_off'), {
    key: 'round_off',
    label: 'Round off',
    amountPaise: -21,
    sublabel: null,
  });
});

test('discount comes off the food before GST, never off the fees', () => {
  const c = price({ discountPaise: 10000 }); // ₹100 off ₹300 of food
  assert.equal(c.food.base, 20000);
  assert.equal(c.food.gst, 1000, 'GST on ₹200, not ₹300');
  assert.equal(c.delivery.customerPays, 3000);
  assert.equal(c.platformFee.total, 1200);
  assert.equal(c.grandTotal, 20000 + 1000 + 3000 + 1200);
  assert.equal(c.lines.find((l) => l.key === 'discount').amountPaise, -10000);

  const capped = price({ discountPaise: 50000 });
  assert.equal(capped.food.discount, 30000, 'discount never exceeds the food');
  assert.equal(capped.food.total, 0);
});

test('tip is added untouched and shown as its own line', () => {
  const c = price({ tipPaise: 2000 });
  assert.equal(c.grandTotal, 37700);
  assert.equal(c.lines.find((l) => l.key === 'tip').amountPaise, 2000);
});

test('dine-in platform fee count: per round, and none on an empty bill', () => {
  assert.equal(price({ orderType: 'dine_in', platformFeeCount: 2 }).platformFee.total, 2400);
  const empty = price({ orderType: 'dine_in', foodSubtotalPaise: 0, platformFeeCount: 0 });
  assert.equal(empty.platformFee.total, 0);
  assert.equal(empty.grandTotal, 0);
});

test('dine-in service charge is included before round-off', () => {
  const c = price({ orderType: 'dine_in', serviceChargePaise: 3000 });
  assert.equal(c.grandTotal, 35700);
  assert.equal(c.lines.find((l) => l.key === 'service_charge').amountPaise, 3000);
});

test('delivery with no known distance is pending: shown as "Calculated at checkout", not totalled', () => {
  const c = price({ distanceKm: null });
  assert.equal(c.delivery.pending, true);
  assert.equal(c.grandTotal, 32700);
  const line = c.lines.find((l) => l.key === 'delivery_fee');
  assert.equal(line.amountPaise, null);
  assert.equal(line.sublabel, 'Calculated at checkout');
});

test('display lines: order, labels, GST sublabels, grand total last', () => {
  const c = price();
  assert.deepEqual(
    c.lines.map((l) => l.key),
    ['item_total', 'food_gst', 'delivery_fee', 'platform_fee', 'grand_total']
  );
  assert.equal(c.lines.find((l) => l.key === 'food_gst').sublabel, '5% of ₹300.00');
  assert.equal(c.lines.find((l) => l.key === 'delivery_fee').sublabel, '1 km · incl. ₹4.58 GST');
  assert.equal(c.lines.find((l) => l.key === 'platform_fee').sublabel, 'incl. ₹1.83 GST');
  assert.equal(c.lines.at(-1).amountPaise, c.grandTotal);
});

test('legacy rupee totals add up to the grand total', () => {
  const c = price({ discountPaise: 5000, tipPaise: 2000 });
  const t = toLegacyTotals(c);
  assert.equal(
    Math.round((t.subtotal + t.deliveryFee + t.platformFee + t.tax + t.tip - t.discountAmount + c.roundOff / 100) * 100),
    c.grandTotal
  );
  assert.equal(t.grandTotal, c.grandTotal / 100);
});

test('rejects non-integer or negative amounts', () => {
  assert.throws(() => price({ foodSubtotalPaise: 300.5 }), TypeError);
  assert.throws(() => price({ tipPaise: -1 }), TypeError);
});

// ── Delivery zone ─────────────────────────────────────────────────────────────

test('resolveDeliveryDistance: located & inside the zone → distance, no issue', () => {
  const restaurant = { location: { coordinates: [77.59, 12.97] }, delivery: { radiusKm: 5 } };
  const { distanceKm, issue } = resolveDeliveryDistance(restaurant, [77.6, 12.97]);
  assert.equal(issue, null);
  assert.ok(distanceKm > 1 && distanceKm < 1.2);
});

test('resolveDeliveryDistance: outside the restaurant\'s own radius → OUT_OF_DELIVERY_RANGE', () => {
  const restaurant = { location: { coordinates: [77.59, 12.97] }, delivery: { radiusKm: 5 } };
  assert.equal(resolveDeliveryDistance(restaurant, [77.7, 12.97]).issue, 'OUT_OF_DELIVERY_RANGE');
  // No radius set → the 25 km platform default.
  const open = { location: { coordinates: [77.59, 12.97] }, delivery: {} };
  assert.equal(resolveDeliveryDistance(open, [77.7, 12.97]).issue, null);
  assert.equal(resolveDeliveryDistance(open, [78.0, 12.97]).issue, 'OUT_OF_DELIVERY_RANGE');
});

test('resolveDeliveryDistance: unlocated address / restaurant', () => {
  const restaurant = { location: { coordinates: [77.59, 12.97] }, delivery: {} };
  assert.equal(resolveDeliveryDistance(restaurant, null).issue, 'ADDRESS_NOT_LOCATED');
  assert.equal(resolveDeliveryDistance(restaurant, []).issue, 'ADDRESS_NOT_LOCATED');
  assert.equal(resolveDeliveryDistance({ delivery: {} }, [77.6, 12.97]).issue, 'RESTAURANT_NOT_LOCATED');
});
