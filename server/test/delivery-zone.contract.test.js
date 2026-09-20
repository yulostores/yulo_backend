// Contract tests for the delivery-zone rule: which restaurants a customer's pin can see.
//
// Datastore-free on purpose (the suite has no Mongo). What can drift, and what these pin:
//
//   * effectiveDeliveryRadiusKm (JS) and EFFECTIVE_RADIUS_KM_EXPR (the same rule as an
//     aggregation expression) must agree — one runs in /api/geo callers' tests and docs, the
//     other inside Mongo, and nothing else would notice them disagreeing.
//   * discoveryStages (what a customer SEES) and serviceableStages (what actually DELIVERS)
//     must stay two different things. Collapsing them back into one is the regression that
//     hid every restaurant which had never filled in the delivery form.
//   * both must still gate on PUBLIC_RESTAURANT_FILTER and on the discovery radius, and
//     serviceableStages must keep the per-restaurant radius $match — dropping any of those
//     silently re-opens the bugs this replaced (pending stores listed, 100 km zones, a flat
//     client radius).
//   * isUsableCoordinatePair must keep rejecting [0, 0], the value a failed location used to
//     be defaulted to.

// First on purpose: fills in the env vars config/env.js demands at import time, which the
// geocoder (and through it the whole service layer) reaches.
import '../test-utils/appHarness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_RADIUS_KM,
  DELIVERS_TO_PIN_EXPR,
  DISCOVERY_RADIUS_KM,
  EFFECTIVE_RADIUS_KM_EXPR,
  MAX_DELIVERY_RADIUS_KM,
  effectiveDeliveryRadiusKm,
} from '../config/delivery.config.js';
import { discoveryStages, serviceableStages } from '../services/restaurant.service.js';
import Restaurant from '../models/Restaurant.js';
import { isUsableCoordinatePair } from '../services/geocode.service.js';
import { PUBLIC_RESTAURANT_FILTER } from '../utils/publicRestaurant.js';

// A tiny evaluator for the only operators EFFECTIVE_RADIUS_KM_EXPR uses, so the expression
// can be run against the same inputs as the JS twin without a database.
const evalExpr = (expr, doc) => {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    return expr.slice(1).split('.').reduce((v, k) => v?.[k], doc);
  }
  if (expr === null || typeof expr !== 'object') return expr;
  const [op, args] = Object.entries(expr)[0];
  const a = Array.isArray(args) ? args.map((x) => evalExpr(x, doc)) : args;
  switch (op) {
    case '$min':
      return Math.min(...a);
    case '$lte':
      return a[0] <= a[1];
    case '$multiply':
      return a.reduce((x, y) => x * y, 1);
    case '$gt':
      return a[0] > a[1];
    case '$ifNull':
      return a[0] ?? a[1];
    case '$cond':
      return a[0] ? a[1] : a[2];
    default:
      throw new Error(`evalExpr: unhandled operator ${op}`);
  }
};

const CASES = [
  [{ radiusKm: 3 }, 3],
  [{ radiusKm: 12 }, 12],
  [{ radiusKm: 8.5 }, 8.5],
  [{ radiusKm: MAX_DELIVERY_RADIUS_KM }, MAX_DELIVERY_RADIUS_KM],
  [{ radiusKm: 100 }, MAX_DELIVERY_RADIUS_KM], // owner form allows 100 — platform clamps it
  [{ radiusKm: 0 }, DEFAULT_DELIVERY_RADIUS_KM], // form allows 0 — must not hide the store
  [{ radiusKm: -2 }, DEFAULT_DELIVERY_RADIUS_KM],
  [{}, DEFAULT_DELIVERY_RADIUS_KM], // delivery saved without a radius
  [undefined, DEFAULT_DELIVERY_RADIUS_KM], // no delivery block at all
];

for (const [delivery, expected] of CASES) {
  test(`delivery radius ${JSON.stringify(delivery)} → ${expected} km (JS and Mongo expression agree)`, () => {
    assert.equal(effectiveDeliveryRadiusKm(delivery), expected);
    assert.equal(evalExpr(EFFECTIVE_RADIUS_KM_EXPR, { delivery }), expected);
  });
}

test('discoveryStages: one $geoNear, bounded by the DISCOVERY radius, gated on public visibility', () => {
  const stages = discoveryStages([85.36, 23.99]);

  assert.equal(stages.length, 1, 'discovery is the $geoNear alone — no zone $match');
  const [geoNear] = stages;
  assert.ok(geoNear.$geoNear, '$geoNear must be the first stage');
  assert.deepEqual(geoNear.$geoNear.near, { type: 'Point', coordinates: [85.36, 23.99] });
  assert.equal(geoNear.$geoNear.maxDistance, DISCOVERY_RADIUS_KM * 1000);
  assert.equal(geoNear.$geoNear.distanceField, 'distanceMeters');
  assert.equal(geoNear.$geoNear.spherical, true);
  for (const [k, v] of Object.entries(PUBLIC_RESTAURANT_FILTER)) {
    assert.equal(geoNear.$geoNear.query[k], v, `query keeps ${k}`);
  }
});

test('discovery is 25 km and reaches at least as far as any restaurant may deliver', () => {
  assert.equal(DISCOVERY_RADIUS_KM, 25);
  assert.ok(
    MAX_DELIVERY_RADIUS_KM <= DISCOVERY_RADIUS_KM,
    'a restaurant must never be able to deliver further than a customer can see'
  );
});

test('a restaurant that never configured a radius covers the whole discovery area', () => {
  // The regression this whole split exists for: the old default was 5 km, so every store
  // created through a form that leaves `delivery` untouched went missing past 5 km.
  assert.equal(effectiveDeliveryRadiusKm(undefined), DISCOVERY_RADIUS_KM);
  assert.equal(effectiveDeliveryRadiusKm({}), DISCOVERY_RADIUS_KM);

  // And the schema must not quietly reinstate it. A `default` on delivery.radiusKm is
  // indistinguishable from an owner's choice once written, which is precisely how the 5 km
  // restriction nobody set became invisible — the default above would never be consulted.
  assert.equal(
    Restaurant.schema.path('delivery.radiusKm').options.default,
    undefined,
    'delivery.radiusKm must have no schema default — the default belongs in delivery.config.js'
  );
  const fresh = new Restaurant({
    ownerId: '664a1b2c3d4e5f6a7b8c9d0e',
    name: 'Fresh',
    location: { type: 'Point', coordinates: [85.3616, 23.9924] },
  });
  assert.equal(fresh.delivery?.radiusKm, undefined, 'a new restaurant stores no radius');
  assert.equal(effectiveDeliveryRadiusKm(fresh.delivery), DISCOVERY_RADIUS_KM);
});

test('serviceableStages: discovery plus the per-restaurant zone $match', () => {
  const [geoNear, match] = serviceableStages([85.36, 23.99]);

  assert.deepEqual(geoNear, discoveryStages([85.36, 23.99])[0], 'shares the discovery stage');
  // The per-restaurant zone check: distance <= effective radius (km → m).
  assert.deepEqual(match.$match.$expr.$lte[0], '$distanceMeters');
  assert.deepEqual(match.$match.$expr.$lte[1].$multiply, [EFFECTIVE_RADIUS_KM_EXPR, 1000]);
});

test('DELIVERS_TO_PIN_EXPR agrees with effectiveDeliveryRadiusKm at, inside and beyond the zone', () => {
  const cases = [
    [{ radiusKm: 8 }, 7_999, true],
    [{ radiusKm: 8 }, 8_000, true], // exactly on the boundary still delivers
    [{ radiusKm: 8 }, 8_001, false],
    [undefined, DISCOVERY_RADIUS_KM * 1000, true], // unset zone covers the whole browse area
    [{ radiusKm: 3 }, 12_000, false], // listed (inside discovery) but out of its own reach
  ];
  for (const [delivery, distanceMeters, expected] of cases) {
    assert.equal(
      evalExpr(DELIVERS_TO_PIN_EXPR, { delivery, distanceMeters }),
      expected,
      `${JSON.stringify(delivery)} at ${distanceMeters}m`
    );
    assert.equal(
      distanceMeters <= effectiveDeliveryRadiusKm(delivery) * 1000,
      expected,
      'the JS twin must give the same answer'
    );
  }
});

test('discoveryStages: string ids in an $in filter are cast (aggregation does not cast them)', () => {
  const [geoNear] = discoveryStages([85.36, 23.99], { _id: { $in: ['664a1b2c3d4e5f6a7b8c9d0e'] } });
  const [id] = geoNear.$geoNear.query._id.$in;
  assert.equal(typeof id, 'object');
  assert.equal(String(id), '664a1b2c3d4e5f6a7b8c9d0e');
});

test('isUsableCoordinatePair rejects the placeholder and malformed points', () => {
  assert.equal(isUsableCoordinatePair([85.3616, 23.9924]), true); // Hazaribagh
  assert.equal(isUsableCoordinatePair([0, 0]), false); // the old silent default
  assert.equal(isUsableCoordinatePair([0, 23.9]), true); // on the meridian is still a place
  assert.equal(isUsableCoordinatePair([181, 10]), false);
  assert.equal(isUsableCoordinatePair([10, 91]), false);
  assert.equal(isUsableCoordinatePair([NaN, 10]), false);
  assert.equal(isUsableCoordinatePair(['85.3', '23.9']), false);
  assert.equal(isUsableCoordinatePair([85.3]), false);
  assert.equal(isUsableCoordinatePair(null), false);
  assert.equal(isUsableCoordinatePair(undefined), false);
});
