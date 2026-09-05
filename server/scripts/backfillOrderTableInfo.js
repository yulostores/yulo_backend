// Backfills Order.tableId / Order.tableNumber / Order.placedBy / Order.statusHistory for
// dine-in orders placed before services/order.service.js started setting them.
//
// The read path (services/orderView.service.js) already resolves the table through
// tableSessionId as a fallback, so nothing is broken without this — but that fallback is
// an extra join on every read, and it can't recover a table that has since been deleted,
// whereas the snapshotted tableNumber written here survives that. Run it once:
//
//   node scripts/backfillOrderTableInfo.js            # report only, writes nothing
//   node scripts/backfillOrderTableInfo.js --apply    # write the changes
//
// Safe to re-run: every update is conditioned on the field still being missing.

import 'dotenv/config';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';

const apply = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);

  const orders = await Order.find({
    type: 'dine_in',
    $or: [{ tableId: null }, { tableNumber: null }, { statusHistory: { $size: 0 } }],
  })
    .select('tableSessionId tableId tableNumber staffId userId placedBy status statusHistory createdAt')
    .lean();

  console.log(`${orders.length} dine-in order(s) missing table or history info`);
  if (orders.length === 0) return;

  const sessionIds = [...new Set(orders.map((o) => String(o.tableSessionId)).filter((v) => v !== 'null'))];
  const sessions = await TableSession.find({ _id: { $in: sessionIds } }).select('tableId').lean();
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));

  const tableIds = [...new Set(sessions.map((s) => String(s.tableId)))];
  const tables = await Table.find({ _id: { $in: tableIds } }).select('identifier').lean();
  const tableById = new Map(tables.map((t) => [String(t._id), t]));

  const writes = [];
  let unresolvable = 0;

  for (const order of orders) {
    const set = {};

    const tableId = order.tableId ?? sessionById.get(String(order.tableSessionId))?.tableId ?? null;
    if (!order.tableId && tableId) set.tableId = tableId;
    if (!order.tableNumber) {
      const identifier = tableById.get(String(tableId))?.identifier ?? null;
      if (identifier) set.tableNumber = identifier;
    }
    if (!order.placedBy) {
      set.placedBy = order.staffId ? 'waiter' : order.userId ? 'customer' : 'guest';
    }
    if (!order.statusHistory || order.statusHistory.length === 0) {
      // Only the placement is recoverable — no record exists of when the historical
      // transitions happened, so the timeline starts there rather than inventing entries.
      set.statusHistory = [
        {
          status: 'placed',
          at: order.createdAt,
          byStaffId: order.staffId ?? null,
          byRole: order.staffId ? 'waiter' : order.userId ? 'customer' : 'guest',
        },
      ];
    }

    if (Object.keys(set).length === 0) continue;
    if (!set.tableNumber && !order.tableNumber) unresolvable += 1;
    writes.push({ updateOne: { filter: { _id: order._id }, update: { $set: set } } });
  }

  console.log(`${writes.length} order(s) to update; ${unresolvable} still without a resolvable table`);

  if (apply && writes.length > 0) {
    const res = await Order.bulkWrite(writes, { ordered: false });
    console.log(`modified ${res.modifiedCount}`);
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
