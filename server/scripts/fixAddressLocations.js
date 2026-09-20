// One-off repair for saved customer addresses whose map point is not a real location.
//
// Three shapes to fix, all of them written before services/address.service.js existed:
//
//   * `location: { type: 'Point', coordinates: [] }` — what the old schema default produced
//     around a failed geocode. Not "no location": it is truthy and correctly typed, so the
//     customer app read it as `{ latitude: undefined }` and stopped loading the home feed
//     for that address entirely, and computeDropKm turned it into NaN on every order placed
//     to it. These become genuinely absent, or a real point if the address can be geocoded.
//   * `[0, 0]` — Null Island, the value a failed lookup used to be defaulted to.
//   * A REVERSED pair, [latitude, longitude] instead of GeoJSON's [longitude, latitude].
//     Nothing rejected these, and anywhere in India both halves are individually valid
//     either way round, so they were stored and then silently wrong forever. Detected by
//     the pair falling outside India while its reverse falls inside, and fixed by swapping
//     — no geocoder call needed, since the coordinates were right all along.
//
// It also backfills `locationSource` so a later reader can tell a repaired address from one
// the customer actually pinned.
//
// An address that can't be geocoded is reported and left with no point, which is the honest
// state — the distance features degrade for it rather than running on a fabricated centre.
//
// Idempotent — addresses that already have a usable point are skipped.
//   node scripts/fixAddressLocations.js          (report only)
//   node scripts/fixAddressLocations.js --apply  (write)
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { geocodeAddress, isUsableCoordinatePair } from '../services/geocode.service.js';
import { composeStreetLine } from '../services/address.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');

// Same envelope services/address.service.js validates against.
const INDIA = { minLng: 68, maxLng: 98, minLat: 6, maxLat: 38 };
const insideIndia = ([lng, lat]) =>
  Number.isFinite(lng) &&
  Number.isFinite(lat) &&
  lng >= INDIA.minLng &&
  lng <= INDIA.maxLng &&
  lat >= INDIA.minLat &&
  lat <= INDIA.maxLat;

await mongoose.connect(process.env.MONGODB_URI);
console.log(`✓ Connected${apply ? '' : '  (dry run — pass --apply to write)'}\n`);

// Only accounts that actually hold an address; .lean() so mongoose hands back what Mongo
// really stores rather than a hydrated document with the new schema's shape applied.
const users = await User.find({ 'savedAddresses.0': { $exists: true } })
  .select('name phone email savedAddresses')
  .lean();

let swapped = 0;
let geocoded = 0;
let cleared = 0;
let ok = 0;

for (const user of users) {
  const who = user.name?.trim() || user.phone || user.email || String(user._id);

  for (const addr of user.savedAddresses) {
    const coords = addr.location?.coordinates;
    if (isUsableCoordinatePair(coords) && insideIndia(coords)) {
      ok += 1;
      continue;
    }

    const line = composeStreetLine(addr) || '(no address text)';
    const was = JSON.stringify(coords ?? null);
    const path = { _id: user._id, 'savedAddresses._id': addr._id };

    // A reversed pair still holds the right place — swap it rather than spending a
    // geocoder call and risking a worse answer than the customer's own pin.
    if (isUsableCoordinatePair(coords) && insideIndia([coords[1], coords[0]])) {
      const fixed = [coords[1], coords[0]];
      console.log(`⇄ ${who} — "${line}"\n    ${was} was reversed → [${fixed.join(', ')}]`);
      if (apply) {
        await User.collection.updateOne(path, {
          $set: {
            'savedAddresses.$.location': { type: 'Point', coordinates: fixed },
            'savedAddresses.$.locationSource': 'device',
          },
        });
      }
      swapped += 1;
      continue;
    }

    const resolved = await geocodeAddress(addr);
    if (resolved && insideIndia(resolved)) {
      console.log(`✓ ${who} — "${line}"\n    ${was} → [${resolved.join(', ')}] (geocoded)`);
      if (apply) {
        await User.collection.updateOne(path, {
          $set: {
            'savedAddresses.$.location': { type: 'Point', coordinates: resolved },
            'savedAddresses.$.locationSource': 'geocoded',
          },
        });
      }
      geocoded += 1;
      continue;
    }

    // $unset rather than writing an empty point back: absent is the state every reader
    // now handles correctly, and the shape this script exists to eliminate.
    console.log(`✗ ${who} — "${line}"\n    ${was} → no geocoder match; point cleared`);
    if (apply) {
      await User.collection.updateOne(path, {
        $unset: { 'savedAddresses.$.location': '' },
        $set: { 'savedAddresses.$.locationSource': 'unknown' },
      });
    }
    cleared += 1;
  }
}

const verb = apply ? 'Fixed' : 'Would fix';
console.log(
  `\n${verb}: ${swapped} reversed pair(s) swapped, ${geocoded} geocoded from the address, ` +
    `${cleared} left without a point; ${ok} already had a usable location.`
);

if (apply && swapped + geocoded + cleared > 0) {
  await recordMigrationRun('fixAddressLocations', { swapped, geocoded, cleared });
}

await mongoose.disconnect();
