// A minimal record of which one-off scripts in this directory have been run
// against a database — the closest this project has to a migration ledger.
//
// Each script calls `recordMigrationRun()` once, after it has finished its work
// and only on a run that actually wrote something (a dry run records nothing).
// The row lands in the `migrations_applied` collection:
//
//   { name, appliedAt, host, db, nodeEnv, ...stats }
//
// It is advisory, not enforced: nothing here reads the collection to gate a run,
// and every script is written to be safe to re-run regardless. Its only job is
// to let you answer "has backfillOrderCustomer been run on prod yet?" from the
// database itself instead of from memory. See README.md for the catalogue.

import mongoose from 'mongoose';

/**
 * Append a run record to `migrations_applied`.
 *
 * @param {string} name   Script name without the `.js` (e.g. 'backfillOrderCustomer').
 * @param {object} [stats] Anything worth keeping about the run — counts, an action
 *                         summary, etc. Merged onto the row.
 */
export async function recordMigrationRun(name, stats = {}) {
  try {
    const conn = mongoose.connection;
    await conn.collection('migrations_applied').insertOne({
      name,
      appliedAt: new Date(),
      host: conn.host ?? null,
      db: conn.name ?? null,
      nodeEnv: process.env.NODE_ENV ?? null,
      ...stats,
    });
    console.log(`  ↳ recorded in migrations_applied`);
  } catch (err) {
    // Bookkeeping must never fail a migration that has already done its work.
    console.warn(`  ↳ could not record in migrations_applied: ${err.message}`);
  }
}
