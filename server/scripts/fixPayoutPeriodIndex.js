// Replaces the rider-payout unique index { partnerId, periodStart } with
// { partnerId, periodType, periodStart } (B10).
//
// The old index made a weekly and a monthly payout that start on the same day (the 1st falling
// on a Monday) collide: the second upsert overwrote or failed against the first. Mongoose
// creates the new index on boot but never drops the old one, so existing databases need this.
//
//   node scripts/fixPayoutPeriodIndex.js
//
// Safe to re-run: it only drops the old index if it is still there, then syncs the model's.

import 'dotenv/config';
import mongoose from 'mongoose';
import Payout from '../models/Payout.js';
import { recordMigrationRun } from './_migrationLog.js';

const OLD = 'partnerId_1_periodStart_1';

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const indexes = await Payout.collection.indexes();
  const hadOld = indexes.some((i) => i.name === OLD);
  if (hadOld) {
    await Payout.collection.dropIndex(OLD);
    console.log(`dropped ${OLD}`);
  } else {
    console.log(`${OLD} not present — nothing to drop`);
  }
  await Payout.syncIndexes();
  console.log('payout indexes now:', (await Payout.collection.indexes()).map((i) => i.name).join(', '));
  if (hadOld) await recordMigrationRun('fixPayoutPeriodIndex', { droppedOld: true });
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
