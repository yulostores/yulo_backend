import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { recordMigrationRun } from './_migrationLog.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('✓ Connected');

const restaurants = await Restaurant.find({
  approvalStatus: { $exists: false },
}).select('isActive createdAt');
console.log(`\nFound ${restaurants.length} restaurant(s) missing approvalStatus`);

let updated = 0;
for (const restaurant of restaurants) {
  if (restaurant.isActive === true) {
    restaurant.approvalStatus = 'active';
    restaurant.reviewedAt = restaurant.createdAt;
  } else {
    restaurant.approvalStatus = 'pending';
  }
  await restaurant.save();
  updated += 1;
}

console.log(`\n✓ Updated ${updated} restaurant(s)`);

if (updated > 0) {
  await recordMigrationRun('backfillRestaurantApprovalStatus', { restaurantsUpdated: updated });
}

await mongoose.disconnect();
