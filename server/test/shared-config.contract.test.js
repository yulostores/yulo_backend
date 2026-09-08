// Contract test for the payment-method catalogue (audit M5).
//
// server/config/appConfig.config.js is the canonical copy. The customer app carries a
// hand-kept synchronous twin in src/services/payments.ts (checkout can't wait on a fetch
// to draw the picker). Nothing stopped the two drifting — add a method on the backend and
// the app keeps rendering the old set until someone remembers the twin. This asserts they
// are identical, so the drift breaks a build instead of shipping.
//
// The two files sit in sibling repos. When the customer app isn't checked out beside this
// one (a backend-only CI job), the test skips loudly rather than failing — the CI workflow
// shows how to add the second checkout to make it run there too.

import { PAYMENT_GROUPS, PAYMENT_METHODS } from '../config/appConfig.config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TWIN_PATH =
  process.env.CUSTOMER_APP_PAYMENTS ||
  resolve(
    import.meta.dirname,
    '../../../yulostores_customer_app/src/services/payments.ts',
  );

/** Slice out `[ ... ]` for `export const <name>`, string-aware so brackets in values don't fool it. */
function extractArrayLiteral(source, name) {
  // Anchor on the `=`, not the name — a TS type annotation (`: PaymentGroup[]`) sits
  // between them and would otherwise be mistaken for the value.
  const decl = new RegExp(`export\\s+const\\s+${name}\\b[^=\\n]*=`).exec(source);
  if (!decl) throw new Error(`${name} not found in ${TWIN_PATH}`);

  let i = source.indexOf('[', decl.index + decl[0].length - 1);
  if (i === -1) throw new Error(`no array literal after ${name}`);

  let depth = 0;
  let quote = null;
  for (let j = i; j < source.length; j++) {
    const ch = source[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return source.slice(i, j + 1);
  }
  throw new Error(`unterminated array literal for ${name}`);
}

/** The literal is data only (strings/numbers/objects) and comes from our own monorepo. */
function evalDataLiteral(literal) {
  return new Function(`return (${literal});`)();
}

let twinSource;
try {
  twinSource = readFileSync(TWIN_PATH, 'utf8');
} catch {
  twinSource = null;
}

test(
  'customer app payments.ts twins server/config/appConfig.config.js',
  { skip: twinSource ? false : `customer app not found at ${TWIN_PATH} — skipping cross-repo check` },
  () => {
    const twinGroups = evalDataLiteral(extractArrayLiteral(twinSource, 'PAYMENT_GROUPS'));
    const twinMethods = evalDataLiteral(extractArrayLiteral(twinSource, 'PAYMENT_METHODS'));

    assert.deepEqual(
      twinGroups,
      PAYMENT_GROUPS,
      'PAYMENT_GROUPS drifted between appConfig.config.js and the customer app payments.ts',
    );
    assert.deepEqual(
      twinMethods,
      PAYMENT_METHODS,
      'PAYMENT_METHODS drifted between appConfig.config.js and the customer app payments.ts',
    );
  },
);
