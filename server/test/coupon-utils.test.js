// CB1 — coupon utilities: code generation and normalisation, age bands, plan and SMS pricing.
// Pure functions; no database.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COUPON_CODE_ALPHABET,
  COUPON_CODE_LENGTH,
  generateCouponCode,
  normalizeCouponCode,
  ageOn,
  ageBand,
  AGE_BAND_NOT_GIVEN,
  AGE_BAND_UNDER_18,
} from '../utils/couponCode.js';
import { planTotals, smsCost } from '../utils/couponPricing.js';
import { SEED_COUPON_PLANS, SEED_COUPON_SETTINGS, PLAN_ONLINE_HANDLING_FEE_PERCENT } from '../config/coupon.config.js';

// ── Codes ─────────────────────────────────────────────────────────────────────

test('the alphabet has no easily misread characters', () => {
  for (const ch of '01OILU') assert.ok(!COUPON_CODE_ALPHABET.includes(ch), `alphabet must not contain ${ch}`);
  assert.equal(new Set(COUPON_CODE_ALPHABET).size, COUPON_CODE_ALPHABET.length);
});

test('generated codes have the right length and alphabet, and 10,000 draws never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i += 1) {
    const code = generateCouponCode();
    assert.equal(code.length, COUPON_CODE_LENGTH);
    for (const ch of code) assert.ok(COUPON_CODE_ALPHABET.includes(ch), `unexpected ${ch} in ${code}`);
    seen.add(code);
  }
  assert.equal(seen.size, 10_000);
});

test('every symbol is drawn roughly equally often (no modulo bias)', () => {
  const counts = new Map();
  const draws = 6_000;
  for (let i = 0; i < draws; i += 1) for (const ch of generateCouponCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const expected = (draws * COUPON_CODE_LENGTH) / COUPON_CODE_ALPHABET.length; // 2,000
  for (const ch of COUPON_CODE_ALPHABET) {
    const n = counts.get(ch) ?? 0;
    // ±15 % is > 6 standard deviations here — a biased generator (byte % 30) skews the first
    // 16 symbols by ~7 %, which this would still let through, so also compare the halves.
    assert.ok(Math.abs(n - expected) < expected * 0.15, `${ch} drawn ${n} times, expected ~${expected}`);
  }
  const firstHalf = [...COUPON_CODE_ALPHABET.slice(0, 16)].reduce((s, ch) => s + counts.get(ch), 0) / 16;
  const secondHalf = [...COUPON_CODE_ALPHABET.slice(16)].reduce((s, ch) => s + counts.get(ch), 0) / 14;
  assert.ok(Math.abs(firstHalf - secondHalf) < expected * 0.05, `halves differ: ${firstHalf} vs ${secondHalf}`);
});

test('normalizeCouponCode accepts what people type and refuses what cannot be a code', () => {
  const code = generateCouponCode();
  assert.equal(normalizeCouponCode(code), code);
  assert.equal(normalizeCouponCode(code.toLowerCase()), code);
  assert.equal(normalizeCouponCode(`${code.slice(0, 5)}-${code.slice(5)}`), code);
  assert.equal(normalizeCouponCode(` ${code.slice(0, 5)} ${code.slice(5)} `), code);
  assert.equal(normalizeCouponCode('ABCDE'), null); // too short
  assert.equal(normalizeCouponCode(`${code}A`), null); // too long
  assert.equal(normalizeCouponCode('ABCDEFGH0O'), null); // characters outside the alphabet
  assert.equal(normalizeCouponCode({ $ne: null }), null); // never a query object
  assert.equal(normalizeCouponCode(null), null);
});

// ── Age bands ─────────────────────────────────────────────────────────────────

// Dates as an Indian calendar day (midnight IST).
const ist = (ymd) => new Date(`${ymd}T00:00:00+05:30`);

test('ageOn counts whole years on the Indian calendar date', () => {
  const at = ist('2026-11-11');
  assert.equal(ageOn(ist('2000-11-11'), at), 26); // birthday today
  assert.equal(ageOn(ist('2000-11-12'), at), 25); // birthday tomorrow
  assert.equal(ageOn(ist('2000-11-10'), at), 26);
  assert.equal(ageOn(ist('2000-02-29'), ist('2026-02-28')), 25); // leap-day birthday, before it
  assert.equal(ageOn(ist('2000-02-29'), ist('2026-03-01')), 26);
  // 23:30 IST on the 10th is still the 10th in India though it is the 10th 18:00 UTC.
  assert.equal(ageOn(ist('2000-11-11'), new Date('2026-11-10T23:30:00+05:30')), 25);
  assert.equal(ageOn(null, at), null);
  assert.equal(ageOn('not a date', at), null);
});

test('ageBand edges', () => {
  const at = ist('2026-11-11');
  assert.equal(ageBand(ist('2008-11-12'), at), AGE_BAND_UNDER_18); // 17
  assert.equal(ageBand(ist('2008-11-11'), at), '18-24'); // 18 today
  assert.equal(ageBand(ist('2001-11-12'), at), '18-24'); // 24
  assert.equal(ageBand(ist('2001-11-11'), at), '25-34'); // 25
  assert.equal(ageBand(ist('1991-11-11'), at), '35-44'); // 35
  assert.equal(ageBand(ist('1981-11-11'), at), '45-54'); // 45
  assert.equal(ageBand(ist('1972-11-12'), at), '45-54'); // 53
  assert.equal(ageBand(ist('1971-11-11'), at), '55+'); // 55
  assert.equal(ageBand(null, at), AGE_BAND_NOT_GIVEN);
  assert.equal(ageBand(ist('2030-01-01'), at), AGE_BAND_NOT_GIVEN); // a future date of birth
});

// ── Pricing ───────────────────────────────────────────────────────────────────

test('plan totals match the agreed prices exactly', () => {
  const byKey = Object.fromEntries(SEED_COUPON_PLANS.map((p) => [p.key, planTotals(p)]));
  // Offline ("Amount Received"): price + 18 % GST, no handling fee.
  assert.deepEqual(byKey.basic, { basePaise: 500_000, handlingFeePaise: 0, gstPaise: 90_000, totalPaise: 590_000 }); // ₹5,900
  assert.deepEqual(byKey.plus, { basePaise: 1_500_000, handlingFeePaise: 0, gstPaise: 270_000, totalPaise: 1_770_000 }); // ₹17,700
  assert.deepEqual(byKey.premium, { basePaise: 5_000_000, handlingFeePaise: 0, gstPaise: 900_000, totalPaise: 5_900_000 }); // ₹59,000
});

test('online plan totals: + 3.5 % payment handling fee, then 18 % GST on price + fee', () => {
  const online = Object.fromEntries(
    SEED_COUPON_PLANS.map((p) => [p.key, planTotals(p, { handlingFeePercent: PLAN_ONLINE_HANDLING_FEE_PERCENT })]),
  );
  assert.equal(PLAN_ONLINE_HANDLING_FEE_PERCENT, 3.5);
  assert.deepEqual(online.basic, { basePaise: 500_000, handlingFeePaise: 17_500, gstPaise: 93_150, totalPaise: 610_650 }); // ₹6,106.50
  assert.deepEqual(online.plus, { basePaise: 1_500_000, handlingFeePaise: 52_500, gstPaise: 279_450, totalPaise: 1_831_950 }); // ₹18,319.50
  assert.deepEqual(online.premium, { basePaise: 5_000_000, handlingFeePaise: 175_000, gstPaise: 931_500, totalPaise: 6_106_500 }); // ₹61,065
});

test('seeded plans carry the agreed allocations', () => {
  const byKey = Object.fromEntries(SEED_COUPON_PLANS.map((p) => [p.key, p]));
  assert.equal(byKey.basic.couponAllocation, 250);
  assert.equal(byKey.plus.couponAllocation, 900);
  assert.equal(byKey.premium.couponAllocation, 4_000);
  for (const p of SEED_COUPON_PLANS) assert.equal(p.complimentaryCount, 5);
});

test('SMS cost is ₹3.54 each, GST on the total', () => {
  assert.deepEqual(smsCost(1, SEED_COUPON_SETTINGS), { pricePaise: 300, gstPaise: 54, totalPaise: 354 });
  assert.deepEqual(smsCost(3, SEED_COUPON_SETTINGS), { pricePaise: 900, gstPaise: 162, totalPaise: 1062 });
  assert.deepEqual(smsCost(1000, SEED_COUPON_SETTINGS), { pricePaise: 300_000, gstPaise: 54_000, totalPaise: 354_000 });
  assert.deepEqual(smsCost(0, SEED_COUPON_SETTINGS), { pricePaise: 0, gstPaise: 0, totalPaise: 0 });
  assert.throws(() => smsCost(-1, SEED_COUPON_SETTINGS), RangeError);
  assert.throws(() => smsCost(1.5, SEED_COUPON_SETTINGS), RangeError);
});
