// Contract test for the store-settings validation twin (audit M5, second half).
//
// config/storeSettings.config.js `validateField` is the canonical rule engine. The
// restaurant portal carries a hand-kept twin, `fieldError` in src/lib/fieldRules.js, so
// the message an owner sees while typing is the same one PATCH would answer with. This
// runs a table of field/value cases through both and asserts identical output — a reword
// or an off-by-one on one side then fails the build instead of shipping a form that
// accepts what the API rejects (or vice versa).
//
// Skips loudly when the restaurant repo isn't checked out beside this one.

import { validateField } from '../config/storeSettings.config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TWIN_PATH =
  process.env.RESTAURANT_FIELD_RULES ||
  resolve(import.meta.dirname, '../../../yulo_restaurant/src/lib/fieldRules.js');

let fieldError = null;
try {
  await access(TWIN_PATH);
  ({ fieldError } = await import(pathToFileURL(TWIN_PATH).href));
} catch {
  /* twin not present — test skips below */
}

// [ description, field descriptor, value ] — chosen to hit every branch both engines share.
const CASES = [
  ['required + empty', { label: 'Owner Name', required: true, type: 'text' }, ''],
  ['required + whitespace only', { label: 'Owner Name', required: true, type: 'text' }, '   '],
  ['optional + empty', { label: 'GST Number', required: false, type: 'text' }, ''],
  ['number: not a number', { label: 'Radius', type: 'number', min: 0 }, 'abc'],
  ['number: below min', { label: 'Radius', type: 'number', min: 0, max: 100 }, -1],
  ['number: above max', { label: 'Radius', type: 'number', min: 0, max: 100 }, 250],
  ['number: not integer', { label: 'Estimated Time', type: 'number', integer: true, min: 0 }, 3.5],
  ['number: valid', { label: 'Radius', type: 'number', min: 0, max: 100 }, 12.5],
  ['string: under minLength', { label: 'Name', type: 'text', minLength: 2 }, 'a'],
  ['string: over maxLength', { label: 'Name', type: 'text', maxLength: 5 }, 'abcdef'],
  [
    'string: pattern mismatch (custom message)',
    { label: 'PIN Code', type: 'text', pattern: '^[1-9][0-9]{5}$', patternMessage: 'Enter a valid 6-digit PIN code' },
    '012345',
  ],
  [
    'string: pattern mismatch (default message)',
    { label: 'Website', type: 'url', pattern: '^https?://' },
    'ftp://x',
  ],
  [
    'select: value not in options',
    { label: 'Legal Entity Type', type: 'select', options: ['Sole proprietorship', 'Partnership'] },
    'LLP',
  ],
  [
    'select: value in options',
    { label: 'Legal Entity Type', type: 'select', options: ['Sole proprietorship', 'Partnership'] },
    'Partnership',
  ],
];

test(
  'restaurant fieldRules.js fieldError() twins storeSettings.config.js validateField()',
  { skip: fieldError ? false : `restaurant repo not found at ${TWIN_PATH} — skipping cross-repo check` },
  () => {
    for (const [desc, field, value] of CASES) {
      assert.equal(
        fieldError(field, value),
        validateField(field, value),
        `validation twins disagree on: ${desc}`,
      );
    }
  },
);
