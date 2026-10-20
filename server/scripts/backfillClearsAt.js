// Gives ledger rows written before B12 their clearing time (RestaurantLedgerEntry.clearsAt).
//
//   node scripts/backfillClearsAt.js            # report only, writes nothing
//   node scripts/backfillClearsAt.js --apply    # write the changes
//
// From B12 online money is only settlement-eligible once Razorpay has settled it to Yulo (T+2
// working days after capture — utils/workingDays.js), so an unsettled online row's eligibleAt
// moves to the later of its event and that clearance, and it joins the statement of the week
// it clears in. Rows already in a statement keep their eligibleAt (that statement stands); every
// other row type (counter dues, refund fees, adjustments, carry-forwards) doesn't wait —
// clearsAt = eligibleAt.
//
// Safe to re-run: only rows with no clearsAt are touched.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import { clearanceTime } from '../utils/workingDays.js';
import { DEFAULT_SETTLEMENT_CYCLE, readSettingsReadOnly } from './_readSettings.js';
import { recordMigrationRun } from './_migrationLog.js';

const ONLINE_TYPES = ['order_earning', 'dine_in_earning'];

export const backfillClearsAt = async ({ apply = false, log = console.log } = {}) => {
  const settings = await readSettingsReadOnly();
  const timezone = (settings?.settlementCycle ?? DEFAULT_SETTLEMENT_CYCLE).timezone;
  const rows = await RestaurantLedgerEntry.find({ $or: [{ clearsAt: null }, { clearsAt: { $exists: false } }] })
    .select('type orderId billId eligibleAt settlementId')
    .lean();

  const counts = { rows: rows.length, moved: 0, unchanged: 0 };
  for (const row of rows) {
    let clearsAt = row.eligibleAt;
    if (ONLINE_TYPES.includes(row.type) && !row.settlementId) {
      const doc = row.orderId
        ? await Order.findById(row.orderId).select('paidAt createdAt').lean()
        : await Bill.findById(row.billId).select('paidAt createdAt').lean();
      const captured = doc?.paidAt ?? doc?.createdAt ?? row.eligibleAt;
      const cleared = clearanceTime(captured, { timezone });
      if (cleared.getTime() > new Date(row.eligibleAt).getTime()) clearsAt = cleared;
    }
    const moves = clearsAt.getTime() !== new Date(row.eligibleAt).getTime();
    if (moves) {
      counts.moved += 1;
      log(`${apply ? 'moved' : 'would move'} ${row.type} ${row._id}: eligible ${new Date(row.eligibleAt).toISOString()} → ${clearsAt.toISOString()}`);
    } else {
      counts.unchanged += 1;
    }
    if (apply) {
      await RestaurantLedgerEntry.updateOne(
        { _id: row._id, $or: [{ clearsAt: null }, { clearsAt: { $exists: false } }], settlementId: row.settlementId ?? null },
        { $set: { clearsAt, eligibleAt: clearsAt } }
      );
    }
  }
  log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${counts.rows} rows without clearsAt — ${counts.moved} ${apply ? 'moved' : 'would move'} to their clearance, ${counts.unchanged} keep their date`);
  return counts;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
      const counts = await backfillClearsAt({ apply });
      if (apply && counts.rows > 0) await recordMigrationRun('backfillClearsAt', counts);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
