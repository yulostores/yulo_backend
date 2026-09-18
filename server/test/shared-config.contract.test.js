// Contract tests for the config the customer app keeps a synchronous twin of.
//
// server/config/appConfig.config.js is the canonical copy of both:
//
//   * the payment-method catalogue, twinned in src/services/payments.ts (checkout can't
//     wait on a fetch to draw the picker), and
//   * the bottom tab bar, twinned in src/services/navigation.ts (the tab bar has to draw
//     on the app's first frame, and keep drawing offline).
//
// Nothing stopped the two sides drifting — add a method or rename a tab on the backend and
// the app keeps rendering the old set until someone remembers the twin. These assert they
// are identical, so the drift breaks a build instead of shipping.
//
// The files sit in sibling repos. When the customer app isn't checked out beside this one
// (a backend-only CI job), the cross-repo tests skip loudly rather than failing — the CI
// workflow shows how to add the second checkout to make them run there too.

import {
  PAYMENT_GROUPS,
  PAYMENT_METHODS,
  TAB_BAR_ITEMS,
  TAB_BAR_LAYOUT,
  TAB_BAR_THEMES,
} from '../config/appConfig.config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_SRC =
  process.env.CUSTOMER_APP_SRC ||
  resolve(import.meta.dirname, '../../../yulostores_customer_app/src');

const TWIN_PATH = process.env.CUSTOMER_APP_PAYMENTS || resolve(APP_SRC, 'services/payments.ts');
const NAV_TWIN_PATH =
  process.env.CUSTOMER_APP_NAVIGATION || resolve(APP_SRC, 'services/navigation.ts');

/**
 * Slice out the `[ ... ]` or `{ ... }` assigned to `export const <name>`, string-aware so
 * a bracket inside a value doesn't fool it.
 */
function extractLiteral(source, name, path) {
  // Anchor on the `=`, not the name — a TS type annotation (`: PaymentGroup[]`) sits
  // between them and would otherwise be mistaken for the value.
  const decl = new RegExp(`export\\s+const\\s+${name}\\b[^=\\n]*=`).exec(source);
  if (!decl) throw new Error(`${name} not found in ${path}`);

  // Whichever of `[` or `{` opens first is the literal.
  const from = decl.index + decl[0].length;
  const candidates = ['[', '{'].map((c) => source.indexOf(c, from)).filter((i) => i !== -1);
  if (!candidates.length) throw new Error(`no literal after ${name} in ${path}`);
  const i = Math.min(...candidates);
  const open = source[i];
  const close = open === '[' ? ']' : '}';

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
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return source.slice(i, j + 1);
  }
  throw new Error(`unterminated literal for ${name} in ${path}`);
}

/** The literal is data only (strings/numbers/objects) and comes from our own monorepo. */
function evalDataLiteral(literal) {
  return new Function(`return (${literal});`)();
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const twinSource = readOrNull(TWIN_PATH);
const navTwinSource = readOrNull(NAV_TWIN_PATH);

test(
  'customer app payments.ts twins server/config/appConfig.config.js',
  { skip: twinSource ? false : `customer app not found at ${TWIN_PATH} — skipping cross-repo check` },
  () => {
    const read = (name) => evalDataLiteral(extractLiteral(twinSource, name, TWIN_PATH));

    assert.deepEqual(
      read('PAYMENT_GROUPS'),
      PAYMENT_GROUPS,
      'PAYMENT_GROUPS drifted between appConfig.config.js and the customer app payments.ts',
    );
    assert.deepEqual(
      read('PAYMENT_METHODS'),
      PAYMENT_METHODS,
      'PAYMENT_METHODS drifted between appConfig.config.js and the customer app payments.ts',
    );
  },
);

test(
  'customer app navigation.ts twins server/config/appConfig.config.js',
  {
    skip: navTwinSource
      ? false
      : `customer app not found at ${NAV_TWIN_PATH} — skipping cross-repo check`,
  },
  () => {
    const read = (name) => evalDataLiteral(extractLiteral(navTwinSource, name, NAV_TWIN_PATH));

    assert.deepEqual(
      read('TAB_BAR_ITEMS'),
      TAB_BAR_ITEMS,
      'TAB_BAR_ITEMS drifted between appConfig.config.js and the customer app navigation.ts',
    );
    assert.deepEqual(
      read('TAB_BAR_THEMES'),
      TAB_BAR_THEMES,
      'TAB_BAR_THEMES drifted between appConfig.config.js and the customer app navigation.ts',
    );
    assert.deepEqual(
      read('TAB_BAR_LAYOUT'),
      TAB_BAR_LAYOUT,
      'TAB_BAR_LAYOUT drifted between appConfig.config.js and the customer app navigation.ts',
    );
  },
);

// The bar is the app's primary navigation, so a config that would render it unusable has
// to fail here rather than on a phone: every destination needs a route it can reach, at
// most one raised circle fits in the middle, and both accent palettes have to define the
// same set of colours or the app turns green into a half-painted bar.
test('tab bar config is renderable', () => {
  assert.ok(TAB_BAR_ITEMS.length > 0, 'the tab bar needs at least one destination');

  const routes = TAB_BAR_ITEMS.map((i) => i.route);
  assert.equal(new Set(routes).size, routes.length, 'two tabs point at the same route');

  const ids = TAB_BAR_ITEMS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'two tabs share an id');

  for (const item of TAB_BAR_ITEMS) {
    assert.ok(item.route, `tab "${item.id}" has no route`);
    assert.ok(item.label, `tab "${item.id}" has no label`);
    assert.ok(['pill', 'fab'].includes(item.shape), `tab "${item.id}" has an unknown shape`);
    assert.ok(
      ['ionicons', 'asset'].includes(item.iconSource),
      `tab "${item.id}" has an unknown iconSource`,
    );
    assert.ok(item.icon && item.activeIcon, `tab "${item.id}" is missing an icon`);
    assert.ok(
      item.badge === null || item.badge === 'cart',
      `tab "${item.id}" has an unknown badge source`,
    );
  }

  assert.ok(
    TAB_BAR_ITEMS.filter((i) => i.shape === 'fab').length <= 1,
    'the bar draws at most one raised circle',
  );

  assert.deepEqual(
    Object.keys(TAB_BAR_THEMES).sort(),
    ['default', 'pure_veg'],
    'the bar needs exactly the two accent palettes the app can be in',
  );
  const [first, ...rest] = Object.values(TAB_BAR_THEMES);
  for (const palette of rest) {
    assert.deepEqual(
      Object.keys(palette).sort(),
      Object.keys(first).sort(),
      'the two tab-bar palettes define different colours',
    );
  }
  for (const [name, palette] of Object.entries(TAB_BAR_THEMES)) {
    for (const [key, value] of Object.entries(palette)) {
      assert.match(value, /^#[0-9A-Fa-f]{6}$/, `${name}.${key} is not a 6-digit hex colour`);
    }
  }

  for (const [key, value] of Object.entries(TAB_BAR_LAYOUT)) {
    assert.ok(
      typeof value === 'number' && Number.isFinite(value) && value >= 0,
      `TAB_BAR_LAYOUT.${key} is not a usable measurement`,
    );
  }
  assert.ok(
    TAB_BAR_LAYOUT.pillHeight <= TAB_BAR_LAYOUT.barHeight,
    'the active pill is taller than the bar it sits in',
  );
  assert.ok(
    TAB_BAR_LAYOUT.fabSize <= TAB_BAR_LAYOUT.barHeight,
    'the raised circle is taller than the bar it sits in',
  );
});
