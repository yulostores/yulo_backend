// Backfills Order.customerName / Order.customerPhone for orders placed before
// services/order.service.js started snapshotting them.
//
// The read path (services/orderView.service.js's enrichOrders) already falls back to the
// account or the table sitting, so no screen is broken without this — but that fallback
// is an extra join on every read and it re-derives the CURRENT name rather than the one
// the order was taken under, so a customer who renames themselves silently rewrites their
// own order history. The snapshot written here is the record; run it once:
//
//   node scripts/backfillOrderCustomer.js            # report only, writes nothing
//   node scripts/backfillOrderCustomer.js --apply    # write the changes
//
// Safe to re-run: every order is skipped once it has a snapshot, and orders whose
// customer genuinely cannot be identified (a walk-in who gave nothing) are left alone
// rather than being stamped with an empty string that would then look snapshotted.
//
// Companion to backfillOrderTableInfo.js (which table) and backfillBillDetails.js (which
// does the same job for receipts) — same dry-run-by-default shape as both.

import 'dotenv/config';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import TableSession from '../models/TableSession.js';
import User from '../models/User.js';
import { recordMigrationRun } from './_migrationLog.js';

const apply = process.argv.includes('--apply');

const clean = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);

  const orders = await Order.find({
    $and: [
      { $or: [{ customerName: null }, { customerName: { $exists: false } }] },
      { $or: [{ customerPhone: null }, { customerPhone: { $exists: false } }] },
    ],
  })
    .select('userId tableSessionId customerName customerPhone')
    .lean();

  console.log(`${orders.length} order(s) without a customer snapshot`);
  if (orders.length === 0) return;

  const userIds = [...new Set(orders.map((o) => o.userId).filter(Boolean).map(String))];
  const users = await User.find({ _id: { $in: userIds } }).select('name phone').lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const sessionIds = [...new Set(orders.map((o) => o.tableSessionId).filter(Boolean).map(String))];
  const sessions = await TableSession.find({ _id: { $in: sessionIds } })
    .select('guestName guestPhone')
    .lean();
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));

  const writes = [];
  // Not a failure: an account created by phone+OTP that never completed its profile has
  // no name to recover, and a walk-in guest who ordered without giving details never had
  // one. Counted so the run says plainly how much of the history stays anonymous.
  let anonymous = 0;

  for (const order of orders) {
    // An account's identity wins over the sitting's: a signed-in customer at a table is
    // the account holder, not the walk-in the sitting may have been opened for.
    const user = order.userId ? userById.get(String(order.userId)) : null;
    const session = order.tableSessionId ? sessionById.get(String(order.tableSessionId)) : null;

    const set = {};
    const name = clean(user?.name) ?? clean(session?.guestName);
    const phone = clean(user?.phone) ?? clean(session?.guestPhone);
    if (name) set.customerName = name;
    if (phone) set.customerPhone = phone;

    if (Object.keys(set).length === 0) {
      anonymous += 1;
      continue;
    }
    writes.push({ updateOne: { filter: { _id: order._id }, update: { $set: set } } });
  }

  console.log(
    `${writes.length} order(s) to update; ${anonymous} with no recoverable customer (left as-is)`
  );

  if (apply && writes.length > 0) {
    const res = await Order.bulkWrite(writes, { ordered: false });
    console.log(`modified ${res.modifiedCount}`);

    await recordMigrationRun('backfillOrderCustomer', {
      ordersModified: res.modifiedCount,
      leftAnonymous: anonymous,
    });
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
