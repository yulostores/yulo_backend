// Backfills Order.paymentChannel / Bill.paymentChannel for documents written before the field
// existed (B1). New writes set it themselves (services/order.service.js, billing.service.js's
// markPaid, payment.service.js's recordCapturedPayment); settlement (B4/B8) reads it to tell
// money Yulo received through Razorpay apart from money paid to the restaurant directly.
//
//   node scripts/backfillPaymentChannel.js            # report only, writes nothing
//   node scripts/backfillPaymentChannel.js --apply    # write the changes
//
// Rules, from what the old fields already say:
//   Order  paymentMethod 'online'                       → 'online'
//          delivery, any other method                   → 'cod'  (cash collected by the rider)
//          takeaway, any other method                   → 'counter'
//          dine_in, paid, non-online method             → 'counter'
//          dine_in still unpaid                         → left null (set when its bill settles)
//   Bill   paidBy 'online'                              → 'online'
//          paidBy cash/upi/card                         → 'counter'
//          still open                                   → left null
//
// Safe to re-run: only documents whose paymentChannel is null/missing are touched.

import 'dotenv/config';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');
const UNSET = { $in: [null] }; // matches both null and a missing field

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);

  const orderUpdates = [
    { label: 'orders → online', filter: { paymentChannel: UNSET, paymentMethod: 'online' }, channel: 'online' },
    {
      label: 'delivery orders → cod',
      filter: { paymentChannel: UNSET, type: 'delivery', paymentMethod: { $ne: 'online' } },
      channel: 'cod',
    },
    {
      label: 'takeaway orders → counter',
      filter: { paymentChannel: UNSET, type: 'takeaway', paymentMethod: { $ne: 'online' } },
      channel: 'counter',
    },
    {
      label: 'paid dine-in orders → counter',
      filter: { paymentChannel: UNSET, type: 'dine_in', paymentStatus: 'paid', paymentMethod: { $ne: 'online' } },
      channel: 'counter',
    },
  ];
  const billUpdates = [
    { label: 'bills → online', filter: { paymentChannel: UNSET, status: 'paid', paidBy: 'online' }, channel: 'online' },
    {
      label: 'bills → counter',
      filter: { paymentChannel: UNSET, status: 'paid', paidBy: { $in: ['cash', 'upi', 'card'] } },
      channel: 'counter',
    },
  ];

  const stats = {};
  for (const [Model, updates] of [
    [Order, orderUpdates],
    [Bill, billUpdates],
  ]) {
    for (const { label, filter, channel } of updates) {
      const count = await Model.countDocuments(filter);
      console.log(`${label}: ${count}`);
      if (apply && count > 0) {
        const res = await Model.updateMany(filter, { $set: { paymentChannel: channel } });
        stats[label] = res.modifiedCount;
      }
    }
  }

  if (apply && Object.keys(stats).length > 0) {
    await recordMigrationRun('backfillPaymentChannel', stats);
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
