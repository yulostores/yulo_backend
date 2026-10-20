// Brings refunds owed under the old code into the refund tracker (models/refundSchema.js).
//
//   node scripts/migrateLegacyRefunds.js            # report only, writes nothing
//   node scripts/migrateLegacyRefunds.js --apply    # write the changes
//
// Before the refund tracker, an order or bill owed back was flagged only by the top-level
// `refundStatus: 'pending'`, with no `refund` sub-document. The admin refunds screen lists —
// and POST /api/admin/finance/refunds/:id/retry acts on — `refund.status`, so those older
// debts were invisible and could not be refunded from the console: customer money Yulo held
// with no way back.
//
// Each one becomes refund { status: 'pending', amountPaise: <its total>, reason }, i.e. "owed,
// not yet sent", and then appears in the refunds screen for an admin to send. The Razorpay fee
// on these is set to the platform (feeBorneBy: 'platform'): the restaurant was never told it
// would bear it, and charging it now would be retroactive.
//
// Left alone and reported instead:
//   - simulated payments (razorpayPaymentId not starting with "pay_") — no money was taken;
//   - anything already carrying a refund.status other than 'none' (already tracked).
// Ones with no Razorpay payment id at all are migrated (so they are visible) but need the
// amount returned by hand — the report lists them.
//
// Safe to re-run: a migrated document has refund.status 'pending', so it is never picked up
// twice; and every write re-checks that it is still untracked.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import { toPaise } from '../utils/money.js';
import { recordMigrationRun } from './_migrationLog.js';

const UNTRACKED = {
  refundStatus: 'pending',
  $or: [{ refund: { $exists: false } }, { refund: null }, { 'refund.status': { $in: [null, 'none'] } }],
};

const REASON = 'Owed before refunds were tracked (legacy refundStatus: pending)';

const isSimulated = (doc) => typeof doc.razorpayPaymentId === 'string' && !doc.razorpayPaymentId.startsWith('pay_');

const migrateCollection = async (Model, label, { apply, log }) => {
  const rows = await Model.collection
    .find(UNTRACKED, { projection: { grandTotal: 1, razorpayPaymentId: 1, restaurantId: 1 } })
    .toArray();
  const simulated = rows.filter(isSimulated);
  const todo = rows.filter((r) => !isSimulated(r));
  const noPayment = todo.filter((r) => !r.razorpayPaymentId);
  const totalPaise = todo.reduce((sum, r) => sum + toPaise(r.grandTotal ?? 0), 0);

  log(`${label}: ${rows.length} legacy refund(s) owed — ${todo.length} to migrate (₹${(totalPaise / 100).toFixed(2)})`);
  if (simulated.length) {
    log(`  ${simulated.length} on a simulated payment (no money taken) — left alone:`);
    for (const r of simulated) log(`    ${r._id}`);
  }
  if (noPayment.length) {
    log(`  ${noPayment.length} with no Razorpay payment id — migrated, but must be refunded by hand:`);
    for (const r of noPayment) log(`    ${r._id}`);
  }
  if (!apply) return { found: rows.length, migrated: 0, simulated: simulated.length, noPayment: noPayment.length };

  let migrated = 0;
  for (const r of todo) {
    const res = await Model.collection.updateOne(
      { _id: r._id, ...UNTRACKED },
      {
        $set: {
          refund: {
            status: 'pending',
            amountPaise: toPaise(r.grandTotal ?? 0),
            razorpayRefundId: null,
            reason: REASON,
            cause: null,
            initiatedBy: null,
            initiatedAt: null,
            processedAt: null,
            failureReason: null,
            attempts: 0,
            feeBorneBy: 'platform',
          },
        },
      }
    );
    migrated += res.modifiedCount;
  }
  log(`  migrated ${migrated}`);
  return { found: rows.length, migrated, simulated: simulated.length, noPayment: noPayment.length };
};

/** The migration itself, on an open connection. Exported for tests. */
export const migrateLegacyRefunds = async ({ apply = false, log = console.log } = {}) => ({
  orders: await migrateCollection(Order, 'Orders', { apply, log }),
  bills: await migrateCollection(Bill, 'Bills', { apply, log }),
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
      const result = await migrateLegacyRefunds({ apply });
      if (apply && result.orders.migrated + result.bills.migrated > 0) {
        await recordMigrationRun('migrateLegacyRefunds', result);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
