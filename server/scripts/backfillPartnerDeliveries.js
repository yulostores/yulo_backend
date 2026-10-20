// Counts every delivery made before riders' totalDeliveries was kept up to date.
//
//   node scripts/backfillPartnerDeliveries.js            # report only, writes nothing
//   node scripts/backfillPartnerDeliveries.js --apply    # write the changes
//
// DeliveryPartner.totalDeliveries used to stay at 0 (nothing ever incremented it), yet admins
// and customers see it and dispatch orders riders by it. From this release each delivered
// order is counted once, when it is closed out (deliveryAssignment.service.js
// countCompletedDelivery), marked by Order.deliveryAssignment.countedAt. This script counts the
// delivered orders that never were: per rider, it marks them counted and adds them to the
// rider's total — in that order, one order at a time, so a run cut short never counts an order
// twice.
//
// Safe to re-run: only delivered orders with no countedAt are touched.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { recordMigrationRun } from './_migrationLog.js';

const UNCOUNTED = {
  'deliveryAssignment.status': 'delivered',
  'deliveryAssignment.partnerId': { $ne: null },
  $or: [{ 'deliveryAssignment.countedAt': null }, { 'deliveryAssignment.countedAt': { $exists: false } }],
};

export const backfillPartnerDeliveries = async ({ apply = false, log = console.log } = {}) => {
  const perPartner = await Order.aggregate([
    { $match: UNCOUNTED },
    { $group: { _id: '$deliveryAssignment.partnerId', orders: { $push: '$_id' } } },
  ]);
  const counts = { partners: perPartner.length, orders: 0, counted: 0 };

  for (const { _id: partnerId, orders } of perPartner) {
    counts.orders += orders.length;
    log(`${apply ? 'counting' : 'would count'} ${orders.length} delivered order(s) for rider ${partnerId}`);
    if (!apply) continue;
    for (const orderId of orders) {
      // Claim first, then add: the same rule the live path uses, so the two never both count it.
      const claimed = await Order.updateOne({ _id: orderId, ...UNCOUNTED }, { $set: { 'deliveryAssignment.countedAt': new Date() } });
      if (!claimed.modifiedCount) continue;
      await DeliveryPartner.updateOne({ _id: partnerId }, { $inc: { totalDeliveries: 1 } });
      counts.counted += 1;
    }
  }
  log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${counts.orders} uncounted delivered order(s) across ${counts.partners} rider(s)${apply ? ` — ${counts.counted} counted` : ''}`);
  return counts;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
      const counts = await backfillPartnerDeliveries({ apply });
      if (apply && counts.counted > 0) await recordMigrationRun('backfillPartnerDeliveries', counts);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
