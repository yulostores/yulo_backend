// B4 — the restaurant's settlement line and the rider's pay (services/settlementMath.service.js),
// pure: the four rows of the PDF's settlement table to the paisa, Yulo's margin, tips, the
// alternative settlement-charge base, the rider formula, and IST settlement weeks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCustomerCharges } from '../services/charges.service.js';
import {
  computeRestaurantSettlementLine,
  computeRiderPay,
  chargesFromLegacyOrder,
} from '../services/settlementMath.service.js';
import { weekBounds } from '../utils/week.js';

const SETTINGS = Object.freeze({
  _id: 'v1',
  foodGstPercent: 5,
  serviceGstPercent: 18,
  customerPlatformFee: 1200,
  deliveryPerKmRate: 2542, // 1 km → the PDF's ₹25.42 delivery base
  deliveryMinCharge: 0,
  deliveryDistanceRounding: 0.1,
  settlementChargePercent: 3.5,
  settlementChargeBase: 'customer_total',
  riderBasePay: 2000,
  riderBaseKm: 2,
  riderPerKmRate: 500,
});
const GST = { gstRegistered: true, delivery: {} };

const charges = (overrides) =>
  computeCustomerCharges({
    orderType: 'delivery',
    foodSubtotalPaise: 30000,
    restaurant: GST,
    distanceKm: 1,
    settings: SETTINGS,
    ...overrides,
  });
const line = (c, channel = 'online', extra = {}) =>
  computeRestaurantSettlementLine({ charges: c, paymentChannel: channel, settings: SETTINGS, ...extra });

test('PDF row 1 — delivery, customer pays delivery: ₹357 → restaurant ₹302.50', () => {
  const l = line(charges());
  assert.equal(l.customerPaid, 35700);
  assert.deepEqual(l.yuloMoney, { platformFee: 1200, deliveryCharge: 3000 });
  assert.deepEqual(l.settlementCharge, { base: 1059, gst: 191, total: 1250, percent: 3.5 });
  assert.equal(l.restaurantBorneDelivery, 0);
  assert.equal(l.planCharge + l.adCharge + l.penalty, 0);
  assert.equal(l.restaurantNet, 30250);
});

test('PDF row 2 — free delivery, restaurant bears ₹30: ₹327 → restaurant ₹273.55', () => {
  const l = line(charges({ restaurant: { gstRegistered: true, delivery: { freeThreshold: 100 } } }));
  assert.equal(l.customerPaid, 32700);
  assert.deepEqual(l.yuloMoney, { platformFee: 1200, deliveryCharge: 0 });
  assert.equal(l.restaurantBorneDelivery, 3000);
  assert.deepEqual(l.settlementCharge, { base: 970, gst: 175, total: 1145, percent: 3.5 });
  assert.equal(l.restaurantNet, 27355);
});

test('PDF row 3 — dine-in paid online: ₹327 → restaurant ₹303.55', () => {
  const l = line(charges({ orderType: 'dine_in', distanceKm: null }));
  assert.equal(l.customerPaid, 32700);
  assert.equal(l.yuloMoney.deliveryCharge, 0);
  assert.equal(l.settlementCharge.total, 1145);
  assert.equal(l.restaurantNet, 30355);
});

test('PDF row 4 — dine-in paid at the counter: restaurant owes ₹12.42', () => {
  const l = line(charges({ orderType: 'dine_in', distanceKm: null }), 'counter');
  assert.equal(l.customerPaid, 0);
  assert.deepEqual(l.yuloMoney, { platformFee: 1200, deliveryCharge: 0 });
  assert.equal(l.settlementCharge.total, 42);
  assert.equal(l.restaurantNet, -1242);
  assert.deepEqual(l.gateway, { fee: 0, tax: 0, total: 0 });
});

test("Yulo's margin = settlement charge − Razorpay's actual fee (₹12.50 − ₹11.38 = ₹1.12)", () => {
  const l = line(charges(), 'online', { razorpayFeePaise: 1138, razorpayTaxPaise: 174 });
  assert.deepEqual(l.gateway, { fee: 964, tax: 174, total: 1138 });
  assert.equal(l.yuloSettlementMargin, 112);
  assert.equal(l.restaurantNet, 30250, 'the restaurant is not charged Razorpay\'s fee — only the flat 3.5 %');
});

test('a tip is the rider\'s: not in the restaurant\'s net, not in the settlement-charge base', () => {
  const l = line(charges({ tipPaise: 2000 }));
  assert.equal(l.customerPaid, 37700);
  assert.equal(l.tip, 2000);
  assert.equal(l.settlementCharge.total, 1250, 'still 3.5 % of ₹357, not of ₹377');
  assert.equal(l.restaurantNet, 30250);
});

test("settlementChargeBase 'restaurant_share' takes the charge on the restaurant's part only", () => {
  const l = computeRestaurantSettlementLine({
    charges: charges(),
    paymentChannel: 'online',
    settings: { ...SETTINGS, settlementChargeBase: 'restaurant_share' },
  });
  // 3.5 % of ₹315 (food + GST) = 11.025 → ₹11.03
  assert.equal(l.settlementCharge.total, 1103);
  assert.equal(l.restaurantNet, 35700 - 1200 - 3000 - 1103);
});

test('rider pay: base covers the first 2 km, ₹5/km beyond, tip on top', () => {
  assert.equal(computeRiderPay({ distanceKm: 1.5, settings: SETTINGS }).total, 2000);
  assert.equal(computeRiderPay({ distanceKm: 2, settings: SETTINGS }).total, 2000);
  const far = computeRiderPay({ distanceKm: 3.4, settings: SETTINGS });
  assert.equal(far.distancePay, 700, '1.4 km × ₹5');
  assert.equal(far.total, 2000 + 1.4 * 500);
  assert.equal(computeRiderPay({ distanceKm: 3.4, tipPaise: 3000, settings: SETTINGS }).total, 5700);
  assert.equal(computeRiderPay({ distanceKm: null, settings: SETTINGS }).total, 2000, 'unknown distance → base only');
});

test('legacy (pre-B3) orders get a usable breakdown from their rupee fields', () => {
  const c = chargesFromLegacyOrder({
    type: 'delivery',
    subtotal: 300,
    tax: 15,
    deliveryFee: 30,
    platformFee: 6,
    tip: 0,
    discountAmount: 0,
    grandTotal: 351,
  });
  assert.equal(c.grandTotal, 35100);
  const l = line(c);
  assert.equal(l.restaurantNet, 35100 - 600 - 3000 - 1229); // 3.5 % of ₹351 = 12.285 → 12.29
});

test('settlement weeks are drawn in IST: Sunday 23:59 and Monday 00:01 fall in different weeks', () => {
  const cycle = { weekStartsOn: 'monday', timezone: 'Asia/Kolkata' };
  const sundayNight = weekBounds(new Date('2026-10-11T18:29:00Z'), cycle); // Sun 23:59 IST
  const mondayMorning = weekBounds(new Date('2026-10-11T18:31:00Z'), cycle); // Mon 00:01 IST
  assert.equal(sundayNight.start.toISOString(), '2026-10-04T18:30:00.000Z'); // Mon 5 Oct 00:00 IST
  assert.equal(sundayNight.end.toISOString(), '2026-10-11T18:29:59.999Z');
  assert.equal(mondayMorning.start.toISOString(), '2026-10-11T18:30:00.000Z'); // Mon 12 Oct 00:00 IST
  assert.notEqual(sundayNight.start.getTime(), mondayMorning.start.getTime());
});
