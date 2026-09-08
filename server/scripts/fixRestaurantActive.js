import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { recordMigrationRun } from './_migrationLog.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('✓ Connected');

const all = await Restaurant.find({}).select('name isActive').lean();
console.log('\nAll restaurants:');
all.forEach(r => {
  console.log(`  ${r.isActive === true ? '✓' : '✗'} "${r.name}"  isActive=${r.isActive}`);
});

const fixed = await Restaurant.updateMany(
  { isActive: { $ne: true } },
  { $set: { isActive: true } }
);
if (fixed.modifiedCount > 0) {
  console.log(`\n✓ Fixed ${fixed.modifiedCount} restaurant(s) — set isActive: true`);
  await recordMigrationRun('fixRestaurantActive', { restaurantsModified: fixed.modifiedCount });
} else {
  console.log('\nNo restaurants needed fixing.');
}

await mongoose.disconnect();
