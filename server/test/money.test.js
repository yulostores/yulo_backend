// B2 — utils/money.js against every figure in the client's Payment Flow document
// (PAYMENT_IMPLEMENTATION_PROMPTS.md § Business rules). Pure; no datastore.

import test from 'node:test';
import assert from 'node:assert/strict';
import { toPaise, toRupees, percentOf, splitInclusiveGst, roundToRupee } from '../utils/money.js';

test('splitInclusiveGst: the GST-inclusive amounts in the PDF split exactly', () => {
  // [inclusive paise, expected base, expected GST] at 18 %
  const cases = [
    [3000, 2542, 458], // delivery ₹30 = 25.42 + 4.58
    [1200, 1017, 183], // platform fee ₹12 = 10.17 + 1.83
    [1250, 1059, 191], // settlement charge ₹12.50 = 10.59 + 1.91
    [1145, 970, 175], // settlement charge ₹11.45 = 9.70 + 1.75
  ];
  for (const [incl, base, gst] of cases) {
    const split = splitInclusiveGst(incl, 18);
    assert.deepEqual(split, { base, gst }, `₹${incl / 100}`);
    assert.equal(split.base + split.gst, incl, 'parts always add back to the whole');
  }
});

test('percentOf: 3.5 % settlement charge on the PDF totals, half-up to the paisa', () => {
  assert.equal(percentOf(35700, 3.5), 1250); // 3.5 % of ₹357 = 12.495 → ₹12.50
  assert.equal(percentOf(32700, 3.5), 1145); // 3.5 % of ₹327 = 11.445 → ₹11.45
  assert.equal(percentOf(1200, 3.5), 42); // 3.5 % of ₹12 = ₹0.42 (cash dine-in)
  assert.equal(percentOf(30000, 5), 1500); // food GST 5 % of ₹300 = ₹15
  assert.equal(percentOf(0, 3.5), 0);
  assert.equal(percentOf(-35700, 3.5), -1250, 'negative amounts round away from zero too');
});

test('the four settlement cases from the PDF reconcile to the paisa', () => {
  const platformFee = 1200;
  const delivery = 3000;
  // Case 1: customer paid ₹357 incl. delivery → restaurant ₹302.50
  assert.equal(35700 - platformFee - delivery - percentOf(35700, 3.5), 30250);
  // Case 2: free delivery, restaurant bears ₹30 → ₹273.55
  assert.equal(32700 - platformFee - delivery - percentOf(32700, 3.5), 27355);
  // Case 3: dine-in Pay Now → ₹303.55
  assert.equal(32700 - platformFee - percentOf(32700, 3.5), 30355);
  // Case 4: dine-in paid at counter → restaurant owes ₹12.42
  assert.equal(-(platformFee + percentOf(platformFee, 3.5)), -1242);
});

test('food GST and delivery GST add up to the ₹21.41 / ₹16.83 in the PDF', () => {
  const foodGst = percentOf(30000, 5);
  const deliveryGst = splitInclusiveGst(3000, 18).gst;
  const platformGst = splitInclusiveGst(1200, 18).gst;
  assert.equal(foodGst + deliveryGst + platformGst, 2141);
  assert.equal(foodGst + platformGst, 1683);
});

test('toPaise: exact for values binary floating point gets wrong', () => {
  assert.equal(toPaise(357), 35700);
  assert.equal(toPaise(357.1), 35710); // 357.1 * 100 = 35709.999…
  assert.equal(toPaise(1.005), 101); // 1.005 * 100 = 100.4999…
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(toPaise(12.5), 1250);
  assert.equal(toPaise(-2.5), -250);
  assert.equal(toPaise(0), 0);
});

test('toRupees: inverse of toPaise for whole paise', () => {
  assert.equal(toRupees(35700), 357);
  assert.equal(toRupees(1145), 11.45);
  assert.equal(toRupees(-1242), -12.42);
});

test('roundToRupee: nearest rupee, half-up, with the round-off line', () => {
  assert.deepEqual(roundToRupee(35741), { rounded: 35700, roundOff: -41 });
  assert.deepEqual(roundToRupee(35750), { rounded: 35800, roundOff: 50 });
  assert.deepEqual(roundToRupee(35700), { rounded: 35700, roundOff: 0 });
  assert.deepEqual(roundToRupee(-150), { rounded: -200, roundOff: -50 });
});

test('inputs that are not money are refused instead of producing NaN', () => {
  assert.throws(() => toPaise(NaN), TypeError);
  assert.throws(() => toPaise('357'), TypeError);
  assert.throws(() => toRupees(12.5), TypeError, 'paise must be whole');
  assert.throws(() => percentOf(100.5, 3.5), TypeError);
  assert.throws(() => percentOf(100, Infinity), TypeError);
  assert.throws(() => splitInclusiveGst(1.2, 18), TypeError);
  assert.throws(() => splitInclusiveGst(1200, -1), RangeError);
  assert.throws(() => roundToRupee(undefined), TypeError);
});
