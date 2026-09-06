import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import QuickFilterChip from '../models/QuickFilterChip.js';
import { uploadBuffer } from '../services/upload.service.js';
import * as cacheService from '../services/cache.service.js';

// Seeds the "What's on your mind?" quick-filter chips shown on the customer Home
// feed. Each icon in assets/seed/quick-filter-chips/ is uploaded to Cloudinary and
// only its secure URL is stored on the QuickFilterChip document — the app fetches
// everything from GET /api/home, nothing is hardcoded.
//
// Idempotent: keyed on `label`, re-running re-uploads the icons (same Cloudinary
// public_id, so the URL is stable) and upserts the docs.
//
//   node scripts/seedQuickFilterChips.js

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'seed', 'quick-filter-chips');
const CLOUDINARY_FOLDER = 'quick-filter-chips';

const CHIPS = [
  { label: 'Biryani', queryParam: 'Biryani', displayOrder: 0, file: 'biryani.png', publicId: 'biryani' },
  {
    label: 'Butter Chicken',
    queryParam: 'Butter Chicken',
    displayOrder: 1,
    file: 'butter-chicken.jpg',
    publicId: 'butter-chicken',
    // Veg mode swaps this chip for Paneer (mirrors search.service.js's veg seed lists).
    veg: { label: 'Paneer', queryParam: 'Paneer', file: 'paneer.jpg', publicId: 'paneer' },
  },
  { label: 'Pizza', queryParam: 'Pizza', displayOrder: 2, file: 'pizza.jpg', publicId: 'pizza' },
  { label: 'Sandwich', queryParam: 'Sandwich', displayOrder: 3, file: 'sandwich.jpg', publicId: 'sandwich' },
  { label: 'Dosa', queryParam: 'Dosa', displayOrder: 4, file: 'dosa.jpg', publicId: 'dosa' },
];

const uploadIcon = async (file, publicId) => {
  const buffer = await readFile(path.join(ASSET_DIR, file));
  const { secureUrl, publicId: id } = await uploadBuffer({
    buffer,
    folder: CLOUDINARY_FOLDER,
    publicId,
  });
  console.log(`  ✓ ${file} -> ${secureUrl}`);
  return { iconUrl: secureUrl, iconPublicId: id };
};

await mongoose.connect(process.env.MONGODB_URI);
console.log('✓ Connected');

for (const chip of CHIPS) {
  console.log(`\n"${chip.label}"`);
  const base = await uploadIcon(chip.file, chip.publicId);

  const veg = chip.veg
    ? {
        label: chip.veg.label,
        queryParam: chip.veg.queryParam,
        ...(await uploadIcon(chip.veg.file, chip.veg.publicId)),
      }
    : { label: null, queryParam: null, iconUrl: null, iconPublicId: null };

  await QuickFilterChip.findOneAndUpdate(
    { label: chip.label },
    {
      label: chip.label,
      queryParam: chip.queryParam,
      displayOrder: chip.displayOrder,
      isActive: true,
      ...base,
      veg,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`  ✓ upserted chip "${chip.label}"`);
}

// Drop the Home feed's cached copy so the new icons show up without waiting out
// the TTL (no-ops when Redis isn't configured).
await cacheService.invalidate('home:quickFilterChips');

console.log('\n✓ Seed complete');
await mongoose.disconnect();
process.exit(0);
