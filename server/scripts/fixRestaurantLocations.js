// One-off repair for restaurants whose map point is not a real location.
//
// Stores added through the super-admin console before it geocoded were saved at
// [0, 0] — off the coast of West Africa. They were approved and "active" but no customer's
// nearby feed can ever include one, because the feed only lists restaurants whose delivery
// zone contains the customer (services/restaurant.service.js). The address was stored
// correctly, so the point can be recovered by geocoding it.
//
// Also catches a missing/short `location.coordinates` and out-of-range values, i.e.
// anything isUsableCoordinatePair rejects.
//
// A restaurant whose address can't be geocoded is reported and left alone — fix its address
// in the admin console (saving an address now re-geocodes it).
//
// Idempotent — restaurants that already have a usable point are skipped.
//   node scripts/fixRestaurantLocations.js          (report only)
//   node scripts/fixRestaurantLocations.js --apply  (write)
import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { geocodeAddress, isUsableCoordinatePair } from '../services/geocode.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);
console.log(`✓ Connected${apply ? '' : '  (dry run — pass --apply to write)'}\n`);

// .lean() so mongoose hands back what Mongo actually holds rather than a hydrated document.
const all = await Restaurant.find({}).select('name address location approvalStatus').lean();

let repaired = 0;
let unresolved = 0;
let ok = 0;

for (const r of all) {
  if (isUsableCoordinatePair(r.location?.coordinates)) {
    ok += 1;
    continue;
  }

  const was = JSON.stringify(r.location?.coordinates ?? null);
  const city = [r.address?.street, r.address?.city].filter(Boolean).join(', ') || '(no address)';
  const coords = await geocodeAddress(r.address);

  if (!coords) {
    console.log(`✗ "${r.name}" (${r._id}) [${r.approvalStatus}]  ${city}\n    location ${was} → no geocoder match; fix the address by hand`);
    unresolved += 1;
    continue;
  }

  console.log(`✓ "${r.name}" (${r._id}) [${r.approvalStatus}]  ${city}\n    location ${was} → [${coords.join(', ')}]`);
  if (apply) {
    await Restaurant.collection.updateOne(
      { _id: r._id },
      { $set: { location: { type: 'Point', coordinates: coords } } }
    );
  }
  repaired += 1;
}

console.log(
  `\n${apply ? '✓ Repaired' : 'Would repair'} ${repaired} restaurant(s); ` +
    `${unresolved} could not be geocoded; ${ok} already had a usable location.`
);

if (apply && repaired > 0) {
  await recordMigrationRun('fixRestaurantLocations', { restaurantsRepaired: repaired, unresolved });
}

await mongoose.disconnect();
