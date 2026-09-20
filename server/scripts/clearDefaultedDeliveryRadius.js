// One-off migration: clear the delivery radius that was never actually chosen.
//
// `Restaurant.delivery.radiusKm` used to carry `default: 5` in the schema, so every
// restaurant created through a form that doesn't ask about delivery — owner sign-up, the
// admin console's Add Store — had 5 km written into its document at creation. Nothing
// distinguished that from an owner deliberately setting 5, and the customer-facing list
// only showed a restaurant to customers inside its radius, so a new store was invisible to
// everyone more than 5 km away with no signal anywhere about why.
//
// The schema default is gone (see models/Restaurant.js) and an UNSET radius now means "the
// owner has not restricted their reach", which the platform reads as the full discovery
// radius. That fixes every restaurant created from here on. This script is for the ones
// already in the database, which still carry the literal 5.
//
// What it changes, and the judgement call in it: it unsets `delivery.radiusKm` wherever it
// is exactly 5, because 5 was the default and there is no stored evidence of who chose it.
// An owner who genuinely wants a 5 km zone can set it again from the portal, where it will
// now be a real choice. Any other value — 3, 8, 12 — was typed by somebody and is left
// strictly alone.
//
// Read the dry run before applying. `--only-unreviewed` is the cautious option: it skips
// restaurants whose delivery block shows other signs of having been filled in (a base
// charge, a free-delivery threshold or an estimated time), on the theory that an owner who
// set those also looked at the radius.
//
// Idempotent.
//   node scripts/clearDefaultedDeliveryRadius.js                   (report only)
//   node scripts/clearDefaultedDeliveryRadius.js --only-unreviewed (report, cautious set)
//   node scripts/clearDefaultedDeliveryRadius.js --apply           (write)
import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import {
  DEFAULT_DELIVERY_RADIUS_KM,
  DISCOVERY_RADIUS_KM,
} from '../config/delivery.config.js';
import { recordMigrationRun } from './_migrationLog.js';

// The value the removed schema default wrote. Hardcoded rather than imported: this script is
// about a historical artefact, and it must keep meaning "the old default" even after
// DEFAULT_DELIVERY_RADIUS_KM changes again.
const LEGACY_DEFAULT_RADIUS_KM = 5;

const apply = process.argv.includes('--apply');
const onlyUnreviewed = process.argv.includes('--only-unreviewed');

// Signs the owner actually opened the delivery form and filled something in.
const looksReviewed = (delivery) =>
  Number(delivery?.baseCharge) > 0 ||
  delivery?.freeThreshold != null ||
  delivery?.estimatedMinutes != null;

await mongoose.connect(process.env.MONGODB_URI);
console.log(`✓ Connected${apply ? '' : '  (dry run — pass --apply to write)'}`);
console.log(
  `  Unsetting delivery.radiusKm === ${LEGACY_DEFAULT_RADIUS_KM} ` +
    `→ treated as ${DEFAULT_DELIVERY_RADIUS_KM} km (the full ${DISCOVERY_RADIUS_KM} km discovery area)` +
    `${onlyUnreviewed ? ', skipping stores whose delivery block looks filled in' : ''}\n`
);

const candidates = await Restaurant.find({ 'delivery.radiusKm': LEGACY_DEFAULT_RADIUS_KM })
  .select('name address approvalStatus delivery')
  .lean();

let cleared = 0;
let skipped = 0;

for (const r of candidates) {
  const where = [r.address?.city, r.address?.state].filter(Boolean).join(', ') || '(no city)';

  if (onlyUnreviewed && looksReviewed(r.delivery)) {
    console.log(`– "${r.name}" (${r._id}) [${r.approvalStatus}]  ${where}\n    delivery block looks filled in; left at ${LEGACY_DEFAULT_RADIUS_KM} km`);
    skipped += 1;
    continue;
  }

  console.log(`✓ "${r.name}" (${r._id}) [${r.approvalStatus}]  ${where}\n    radiusKm ${LEGACY_DEFAULT_RADIUS_KM} → unset (reaches ${DEFAULT_DELIVERY_RADIUS_KM} km)`);
  if (apply) {
    await Restaurant.collection.updateOne(
      { _id: r._id },
      { $unset: { 'delivery.radiusKm': '' } }
    );
  }
  cleared += 1;
}

const others = await Restaurant.countDocuments({
  'delivery.radiusKm': { $exists: true, $ne: LEGACY_DEFAULT_RADIUS_KM },
});

console.log(
  `\n${apply ? '✓ Cleared' : 'Would clear'} ${cleared} restaurant(s); ` +
    `${skipped} skipped as already reviewed; ` +
    `${others} have a radius somebody chose and were not touched.`
);

if (apply && cleared > 0) {
  await recordMigrationRun('clearDefaultedDeliveryRadius', { cleared, skipped, onlyUnreviewed });
}

await mongoose.disconnect();
