// Replaces the discount code index { code, restaurantId } (unique, sparse) with the same keys
// unique only where `code` is a string (live customer activity, A4).
//
// The old index was `sparse`, but a compound sparse index still indexes any document that has
// one of its fields — restaurantId is always there, and `code` defaults to null — so a
// restaurant could never hold a second code-less offer (an automatic offer, or a personal
// offer from the live dashboard): the insert failed with E11000. Mongoose creates the new
// index on boot but never drops the old one, so existing databases need this.
//
//   node scripts/fixDiscountCodeIndex.js
//
// Safe to re-run: it only drops the old index if it is still there, then syncs the model's.
// Existing codes stay unique (the new index is built over the same string codes).

import 'dotenv/config';
import mongoose from 'mongoose';
import Discount from '../models/Discount.js';
import { recordMigrationRun } from './_migrationLog.js';

const OLD = 'code_1_restaurantId_1';

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const indexes = await Discount.collection.indexes();
  const hadOld = indexes.some((i) => i.name === OLD);
  if (hadOld) {
    await Discount.collection.dropIndex(OLD);
    console.log(`dropped ${OLD}`);
  } else {
    console.log(`${OLD} not present — nothing to drop`);
  }
  await Discount.syncIndexes();
  console.log('discount indexes now:', (await Discount.collection.indexes()).map((i) => i.name).join(', '));
  if (hadOld) await recordMigrationRun('fixDiscountCodeIndex', { droppedOld: true });
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
