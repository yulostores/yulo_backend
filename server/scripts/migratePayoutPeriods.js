// Retires rider-payout rows keyed on an old period start (B10).
//
// Before B10, weekly/monthly rider payouts were keyed on the server's (UTC) Monday / 1st; they
// are now keyed on the settlement time zone's (IST) Monday / 1st. A week that spans the switch
// therefore has two rows over almost the same dates. The app already refuses to pay or adjust an
// old-format row, and leaves out of the current row any delivery a PAID old row already covered
// (services/payout.service.js) — this script clears out the pending old rows:
//
//   - pending, with admin incentives/deductions → those are moved onto the current row covering
//     most of its dates (unless that row is already paid — then it is reported, not touched),
//     then the old row is deleted
//   - pending, nothing entered by an admin → deleted (the current row is recomputed on read)
//   - paid / processing → kept as history, reported
//
//   node scripts/migratePayoutPeriods.js            # dry run: report only
//   node scripts/migratePayoutPeriods.js --apply    # make the changes
//
// The dry run writes nothing (not even Finance Settings); --apply needs them seeded first.
//
// Safe to re-run: once the old pending rows are gone it finds nothing to do.

import 'dotenv/config';
import mongoose from 'mongoose';
import Payout from '../models/Payout.js';
import { DEFAULT_SETTLEMENT_CYCLE, NO_SETTINGS_MESSAGE, readSettingsReadOnly } from './_readSettings.js';
import { ensurePayoutForPeriod, isCanonicalPeriod } from '../services/payout.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const FROZEN = ['paid', 'processing'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The migration itself, on an open connection. Exported for tests. */
export const migratePayoutPeriods = async ({ apply = false, log = console.log } = {}) => {
  // Read-only: a dry run must not seed Finance Settings as a side effect.
  const stored = await readSettingsReadOnly();
  if (!stored && apply) throw new Error(NO_SETTINGS_MESSAGE);
  if (!stored) log('No Finance Settings yet — reporting against the default cycle (Monday, Asia/Kolkata)');
  const settlementCycle = stored?.settlementCycle ?? DEFAULT_SETTLEMENT_CYCLE;
  const rows = await Payout.find({}).lean();
  const legacy = rows.filter((r) => !isCanonicalPeriod(r, settlementCycle));
  const counts = { legacy: legacy.length, deleted: 0, carriedOver: 0, keptPaid: 0, needsReview: 0 };

  for (const row of legacy) {
    const label = `${row.periodType} ${row.periodStart.toISOString()} partner ${row.partnerId}`;
    if (FROZEN.includes(row.status)) {
      counts.keptPaid += 1;
      log(`keep (${row.status}): ${label}`);
      continue;
    }
    const adminEntered = (row.incentives ?? 0) !== 0 || (row.deductions ?? 0) !== 0;
    if (adminEntered) {
      // The current row covering most of the old row's dates — the one holding its midpoint.
      const mid = new Date((row.periodStart.getTime() + row.periodEnd.getTime()) / 2);
      if (!apply) {
        log(`would move incentives ${row.incentives} / deductions ${row.deductions} to the current row, then delete: ${label}`);
        counts.carriedOver += 1;
        continue;
      }
      const target = await ensurePayoutForPeriod(row.partnerId, row.periodType, mid);
      if (FROZEN.includes(target.status)) {
        counts.needsReview += 1;
        log(`REVIEW — current row is already ${target.status}; incentives/deductions not moved: ${label}`);
        continue;
      }
      const incentives = round2((target.incentives ?? 0) + (row.incentives ?? 0));
      const deductions = round2((target.deductions ?? 0) + (row.deductions ?? 0));
      const notes = [target.notes, row.notes].filter(Boolean).join(' | ');
      const moved = await Payout.updateOne(
        { _id: target._id, status: 'pending' },
        {
          $set: {
            incentives,
            deductions,
            netPayable: round2(target.grossEarnings + (target.tips ?? 0) + incentives - deductions),
            ...(notes ? { notes } : {}),
          },
        }
      );
      if (!moved.modifiedCount) {
        counts.needsReview += 1;
        log(`REVIEW — current row changed meanwhile; not moved: ${label}`);
        continue;
      }
      await Payout.deleteOne({ _id: row._id, status: 'pending' });
      counts.carriedOver += 1;
      log(`moved incentives/deductions and deleted: ${label}`);
      continue;
    }
    if (apply) await Payout.deleteOne({ _id: row._id, status: 'pending' });
    counts.deleted += 1;
    log(`${apply ? 'deleted' : 'would delete'}: ${label}`);
  }
  return counts;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      const counts = await migratePayoutPeriods({ apply });
      console.log(`${apply ? 'APPLIED' : 'DRY RUN'}:`, counts);
      if (apply && (counts.deleted || counts.carriedOver)) await recordMigrationRun('migratePayoutPeriods', counts);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
