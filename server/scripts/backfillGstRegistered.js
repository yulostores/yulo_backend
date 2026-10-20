// Decides Restaurant.gstRegistered (added in B2) for restaurants nobody has decided it for.
//
//   node scripts/backfillGstRegistered.js            # report only, writes nothing
//   node scripts/backfillGstRegistered.js --apply    # write the changes
//
// Why it matters: from B3, food GST is charged only on GST-registered restaurants' orders, so
// a registered restaurant left undecided would stop charging GST it owes. Run it BEFORE the
// release goes live (the old code ignores the field, so it is safe to set early) and once more
// right after — see DEPLOYMENT.md.
//
// The rule: a restaurant with a well-formed GSTIN on file is GST-registered; anything else is
// not. A number on file that is NOT a valid GSTIN (an old placeholder, a typo) is reported by
// name and left not-registered — registering it would make GST mandatory with a number the
// owner can't save, and charge GST against an invalid registration. Fix those by hand, then
// let the owner (store settings) or an admin (store profile) switch them on.
//
// Which restaurants it touches — only values nobody chose:
//   - gstRegistered missing (created before the field existed), and
//   - gstRegistered false with no gstRegisteredSource — a legacy restaurant whose "false" was
//     only ever a schema default written back by an unrelated save.
// A value set by the owner, an admin, on creation or by an earlier run (gstRegisteredSource)
// is never overwritten, so it is safe to re-run.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import { GSTIN_PATTERN } from '../config/storeSettings.config.js';
import { recordMigrationRun } from './_migrationLog.js';

const GSTIN = new RegExp(GSTIN_PATTERN);
const isValidGstin = (value) => typeof value === 'string' && GSTIN.test(value.trim().toUpperCase());

const UNDECIDED = {
  $or: [
    { gstRegistered: { $exists: false } },
    { gstRegistered: null },
    { gstRegistered: false, gstRegisteredSource: { $exists: false } },
  ],
};

/** The backfill itself, on an open connection. Exported for tests. */
export const backfillGstRegistered = async ({ apply = false, log = console.log } = {}) => {
  // Raw collection reads: the model's defaults must not paint a value onto what is missing.
  const rows = await Restaurant.collection
    .find(UNDECIDED, { projection: { name: 1, 'settings.gstNumber': 1 } })
    .toArray();

  const registered = [];
  const notRegistered = [];
  const malformed = [];
  for (const r of rows) {
    const number = typeof r.settings?.gstNumber === 'string' ? r.settings.gstNumber.trim() : '';
    if (isValidGstin(number)) registered.push(r);
    else {
      notRegistered.push(r);
      if (number) malformed.push(r);
    }
  }

  log(`${rows.length} restaurant(s) with no GST registration decided`);
  log(`→ gstRegistered: true  (valid GSTIN on file):  ${registered.length}`);
  log(`→ gstRegistered: false (no valid GSTIN):       ${notRegistered.length}`);
  if (malformed.length) {
    log(`  of which ${malformed.length} hold a GST number that is NOT a valid GSTIN — check these by hand:`);
    for (const r of malformed) log(`    ${r._id}  ${r.name ?? '(no name)'}`);
  }

  const counts = { setTrue: 0, setFalse: 0, malformed: malformed.length };
  if (!apply || rows.length === 0) return counts;

  const now = new Date();
  // Each write re-checks "still undecided", so an owner who decides in the meantime wins.
  const decide = async (list, value) => {
    if (!list.length) return 0;
    const res = await Restaurant.collection.updateMany(
      { _id: { $in: list.map((r) => r._id) }, ...UNDECIDED },
      { $set: { gstRegistered: value, gstRegisteredSource: 'backfill', gstRegisteredSetAt: now } }
    );
    return res.modifiedCount;
  };
  counts.setTrue = await decide(registered, true);
  counts.setFalse = await decide(notRegistered, false);
  log(`modified ${counts.setTrue} → true, ${counts.setFalse} → false`);
  return counts;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
      const counts = await backfillGstRegistered({ apply });
      if (apply && counts.setTrue + counts.setFalse > 0) await recordMigrationRun('backfillGstRegistered', counts);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
