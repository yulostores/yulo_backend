// Creates Finance Settings version 1, if no version exists yet.
//
//   node scripts/seedFinanceSettings.js            # shows what would be seeded, writes nothing
//   node scripts/seedFinanceSettings.js --apply    # seeds version 1 and prints it
//
// Version 1 is effective from 1970, can never be edited or backdated (versions are immutable —
// later changes are new versions, from the super admin portal or POST /api/admin/finance/
// settings), and the ledger backfill prices legacy orders with it. So it must be seeded ONCE,
// deliberately, with the PRODUCTION environment:
//
//   - The agreed business defaults (platform fee ₹12, rider ₹20 for 2 km + ₹5/km, settlement
//     charge 3.5 %, COD off …) apply, EXCEPT where one of the legacy env vars below is set in
//     the environment this runs in — those win. Running it from a laptop with a dev .env
//     freezes that laptop's values into production. Use the production environment (e.g. the
//     App Platform console, or DOTENV_CONFIG_PATH pointing at the production env file).
//   - The app seeds version 1 by itself on first read if this was never run; running this
//     first, and checking the printed values, is how you make sure it seeds what you meant.
//
// Idempotent — with any version present it prints the active one and changes nothing.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import FinanceSettings from '../models/FinanceSettings.js';
import { env } from '../config/env.js';
import { getActiveSettings } from '../services/financeSettings.service.js';

// The env vars that override the business defaults at seed time (services/financeSettings.service.js
// seedDefaults) — rates, not secrets.
const SEED_OVERRIDES = [
  ['CART_TAX_PERCENT', 'foodGstPercent', 'percent', '5'],
  ['CART_PLATFORM_FEE', 'customerPlatformFee', 'rupees', '12'],
  ['COD_ENABLED', 'codEnabled', 'boolean', 'false'],
  ['DELIVERY_PARTNER_PER_DELIVERY_RATE', 'riderBasePay', 'rupees', '20'],
  ['DELIVERY_PARTNER_PER_KM_RATE', 'riderPerKmRate', 'rupees', '5'],
];

/** Exported for tests. Returns { seeded, active | preview }. */
export const seedFinanceSettings = async ({ apply = false, log = console.log } = {}) => {
  const existing = await FinanceSettings.countDocuments();
  if (existing > 0) {
    const active = await getActiveSettings();
    const { _id, __v, createdAt, updatedAt, ...shown } = active;
    log(`Finance settings already present (${existing} version(s)) — nothing changed. Active:`);
    log(JSON.stringify(shown, null, 2));
    return { seeded: false, active };
  }

  const preview = SEED_OVERRIDES.map(([envVar, field, unit, fallback]) => ({
    field,
    envVar,
    unit,
    value: env[envVar] !== undefined ? String(env[envVar]) : fallback,
    fromEnv: env[envVar] !== undefined,
  }));
  log('No finance settings exist. Version 1 will hold the business defaults, with these values:');
  for (const p of preview) {
    log(`  ${p.field.padEnd(20)} ${p.value.padEnd(8)} (${p.unit}) ${p.fromEnv ? `← from ${p.envVar} in THIS environment` : 'default'}`);
  }
  if (preview.some((p) => p.fromEnv)) {
    log('Values marked "from …" come from the environment this script runs in — make sure it is production.');
  }
  if (!apply) {
    log('Dry run — nothing written. Re-run with --apply to seed version 1.');
    return { seeded: false, preview };
  }

  // The unique index on `version` must exist BEFORE the insert: on a fresh database two
  // processes seeding at once would otherwise both insert a version 1, and the index could
  // then never be built.
  await FinanceSettings.init();
  const active = await getActiveSettings();
  const { _id, __v, createdAt, updatedAt, ...shown } = active;
  log('Seeded version 1:');
  log(JSON.stringify(shown, null, 2));
  return { seeded: true, active };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => seedFinanceSettings({ apply: process.argv.includes('--apply') }))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
