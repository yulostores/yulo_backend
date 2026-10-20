// Moves support tickets onto the B12 status vocabulary:
//
//   in_progress → in_review      closed → resolved (resolvedAt kept, or set to updatedAt)
//
// The app already writes only the new values (models/SupportTicket.js normalises on save) and
// reads both, so this is housekeeping: it makes the stored data match what every screen shows
// and lets the old values be dropped from the schema later.
//
//   node scripts/migrateTicketStatuses.js            # dry run: report only
//   node scripts/migrateTicketStatuses.js --apply    # make the changes
//
// Safe to re-run: once no ticket carries an old value it finds nothing to do.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import SupportTicket from '../models/SupportTicket.js';
import { recordMigrationRun } from './_migrationLog.js';

/** The migration itself, on an open connection. Exported for tests. */
export const migrateTicketStatuses = async ({ apply = false, log = console.log } = {}) => {
  const col = SupportTicket.collection;
  const inProgress = await col.countDocuments({ status: 'in_progress' });
  const closed = await col.countDocuments({ status: 'closed' });
  log(`in_progress → in_review: ${inProgress}`);
  log(`closed → resolved: ${closed}`);
  if (!apply) return { inProgress, closed, updated: 0 };

  const a = await col.updateMany({ status: 'in_progress' }, { $set: { status: 'in_review' } });
  // A closed ticket was finished; keep when it was resolved, or fall back to its last update.
  const b = await col.updateMany({ status: 'closed' }, [
    { $set: { status: 'resolved', resolvedAt: { $ifNull: ['$resolvedAt', '$updatedAt'] } } },
  ]);
  const updated = a.modifiedCount + b.modifiedCount;
  log(`updated ${updated}`);
  return { inProgress, closed, updated };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
      const result = await migrateTicketStatuses({ apply });
      if (apply && result.updated > 0) await recordMigrationRun('migrateTicketStatuses', result);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
