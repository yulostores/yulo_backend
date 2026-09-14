// Deletes guest accounts (role: 'guest', see controllers/auth.controller.js's
// guestLogin) that were never upgraded to a real customer and have gone stale — plus
// whatever cart/favorites/search history they left behind.
//
// A guest User is cheap and short-lived by design (its refresh token expires in
// JWT_REFRESH_EXPIRES, same as a customer's), but one that's abandoned mid-browse
// still sits in the database forever unless something reaps it. This is that
// something — meant to run on a schedule (a cron job / DigitalOcean scheduled job),
// not as a one-time migration.
//
//   node scripts/cleanupStaleGuests.js                 # report only, deletes nothing
//   node scripts/cleanupStaleGuests.js --apply          # delete
//   node scripts/cleanupStaleGuests.js --apply --days 3 # override the 7-day default
//
// Safe to re-run on any schedule: it only ever matches documents whose role is still
// 'guest' — an upgraded/merged one (see services/guestAccount.service.js) has already
// changed role or been deleted, so this can never touch a real customer account.

import 'dotenv/config';
import mongoose from 'mongoose';
import Cart from '../models/Cart.js';
import Favorite from '../models/Favorite.js';
import SearchHistory from '../models/SearchHistory.js';
import User from '../models/User.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');
const daysFlagIndex = process.argv.indexOf('--days');
const staleDays = daysFlagIndex !== -1 ? Number(process.argv[daysFlagIndex + 1]) : 7;

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);

  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const staleGuests = await User.find({ role: 'guest', createdAt: { $lt: cutoff } })
    .select('_id')
    .lean();

  console.log(`${staleGuests.length} guest account(s) older than ${staleDays} day(s)`);
  if (staleGuests.length === 0) return;

  const guestIds = staleGuests.map((g) => g._id);

  if (!apply) {
    const [carts, favorites, searches] = await Promise.all([
      Cart.countDocuments({ userId: { $in: guestIds } }),
      Favorite.countDocuments({ userId: { $in: guestIds } }),
      SearchHistory.countDocuments({ userId: { $in: guestIds } }),
    ]);
    console.log(`would also delete: ${carts} cart(s), ${favorites} favorite(s), ${searches} search row(s)`);
    return;
  }

  const [{ deletedCount: carts }, { deletedCount: favorites }, { deletedCount: searches }] =
    await Promise.all([
      Cart.deleteMany({ userId: { $in: guestIds } }),
      Favorite.deleteMany({ userId: { $in: guestIds } }),
      SearchHistory.deleteMany({ userId: { $in: guestIds } }),
    ]);
  const { deletedCount: users } = await User.deleteMany({ _id: { $in: guestIds } });

  console.log(`deleted ${users} guest user(s), ${carts} cart(s), ${favorites} favorite(s), ${searches} search row(s)`);

  await recordMigrationRun('cleanupStaleGuests', { users, carts, favorites, searches, staleDays });
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
