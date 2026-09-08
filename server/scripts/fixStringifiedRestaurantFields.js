// One-off repair for restaurants saved through PATCH /owner/:rId/settings before that
// endpoint JSON-decoded its multipart fields (see parseJsonField in
// controllers/owner/settings.controller.js). Those saves stored `address` as a raw JSON
// string and `cuisineTypes` as a one-element array holding a JSON string, which reads back
// as an address with every subfield undefined — so the owner's store settings looked empty
// no matter how many times they saved. Worse, it also blocks every later save: Mongo
// cannot write `address.city` through a string and answers "Cannot create field 'city' in
// element {address: ...}".
//
// Re-geocoding is part of the repair, not a nicety: while `address` was a string,
// formatAddress() produced "" and the location point silently stopped tracking the
// restaurant's real address.
//
// Idempotent — documents already holding proper objects are skipped.
//   node scripts/fixStringifiedRestaurantFields.js          (report only)
//   node scripts/fixStringifiedRestaurantFields.js --apply  (write)
import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { geocodeAddress } from '../services/geocode.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');

const parse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

await mongoose.connect(process.env.MONGODB_URI);
console.log(`✓ Connected${apply ? '' : '  (dry run — pass --apply to write)'}\n`);

// .lean() so mongoose hands back what Mongo actually holds; hydrating would coerce the
// corrupt values into the schema's shape and hide exactly what we're looking for.
const all = await Restaurant.find({}).lean();

const settingsDefaults = Object.fromEntries(
  Object.entries(Restaurant.schema.paths)
    .filter(([path, type]) => path.startsWith('settings.') && type.options.default !== undefined)
    .map(([path, type]) => [path.slice('settings.'.length), type.options.default])
);

let repaired = 0;
let skipped = 0;

for (const r of all) {
  const set = {};
  const notes = [];

  if (typeof r.address === 'string') {
    const parsed = parse(r.address);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      set.address = {
        street: parsed.street ?? '',
        city: parsed.city ?? '',
        state: parsed.state ?? '',
        pincode: parsed.pincode ?? '',
      };
      notes.push(`address → { ${Object.entries(set.address).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')} }`);
    } else {
      // Not JSON at all — a bare street string. Keep it as the street rather than
      // discarding the only address the owner ever typed.
      set.address = { street: r.address, city: '', state: '', pincode: '' };
      notes.push(`address → { street: ${r.address} }  (not JSON; kept as street)`);
    }
  }

  // `settings` rode the same multipart path as `address`, so it can be stringified too —
  // and while it is, every settings.* read (GST number, PAN, licence expiry) comes back
  // undefined and the compliance section of the store-settings form shows empty.
  if (typeof r.settings === 'string') {
    const parsed = parse(r.settings);
    const merged = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    // Schema defaults only apply on insert, so they have to be written explicitly here or
    // the restaurant loses its GST and service-charge percentages.
    set.settings = { ...settingsDefaults, ...merged };
    notes.push(`settings → { ${Object.keys(set.settings).join(', ')} }`);
  }

  const badCuisines = (r.cuisineTypes ?? []).some((c) => typeof c === 'string' && c.trim().startsWith('['));
  if (badCuisines) {
    const flattened = [
      ...new Set(
        (r.cuisineTypes ?? []).flatMap((c) => {
          const parsed = typeof c === 'string' && c.trim().startsWith('[') ? parse(c) : null;
          return Array.isArray(parsed) ? parsed : [c];
        })
      ),
    ].filter((c) => typeof c === 'string' && c.trim());
    set.cuisineTypes = flattened;
    notes.push(`cuisineTypes → [${flattened.join(', ')}]`);
  }

  if (!notes.length) {
    skipped += 1;
    continue;
  }

  // Only worth re-geocoding when the address was the thing that was broken.
  if (set.address) {
    const coords = await geocodeAddress(set.address);
    if (coords) {
      set.location = { type: 'Point', coordinates: coords };
      notes.push(`location → [${coords.join(', ')}]`);
    } else {
      notes.push('location → unchanged (geocoder found no match)');
    }
  }

  console.log(`✗ "${r.name}" (${r._id})`);
  notes.forEach((n) => console.log(`    ${n}`));

  if (apply) {
    await Restaurant.collection.updateOne({ _id: r._id }, { $set: set });
  }
  repaired += 1;
}

console.log(
  `\n${apply ? '✓ Repaired' : 'Would repair'} ${repaired} restaurant(s); ${skipped} already clean.`
);

if (apply && repaired > 0) {
  await recordMigrationRun('fixStringifiedRestaurantFields', { restaurantsRepaired: repaired });
}

await mongoose.disconnect();
