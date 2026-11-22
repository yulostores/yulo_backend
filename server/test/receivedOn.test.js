import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receivedOnSchema } from '../utils/receivedOn.js';

const istYmd = (d) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

test('receivedOn: a date-only value is that day in IST', () => {
  assert.equal(receivedOnSchema.parse('2026-11-21').toISOString(), '2026-11-20T18:30:00.000Z');
});

test("receivedOn: today's IST date is accepted at any hour, including 00:00-05:30 IST", (t) => {
  // 00:45 IST on 21 Nov = 19:15 UTC on 20 Nov — the time the plan dialog failed.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T19:15:00Z') });
  assert.equal(istYmd(new Date()), '2026-11-21');
  assert.ok(receivedOnSchema.safeParse('2026-11-21').success);
  assert.equal(receivedOnSchema.safeParse('2026-11-22').success, false);
});

test('receivedOn: full timestamps are used as given; future ones are refused', () => {
  assert.ok(receivedOnSchema.safeParse(new Date().toISOString()).success);
  assert.equal(receivedOnSchema.safeParse(new Date(Date.now() + 3_600_000).toISOString()).success, false);
  assert.equal(receivedOnSchema.safeParse('2999-01-01').success, false);
  assert.equal(receivedOnSchema.safeParse('not a date').success, false);
});
