// Backfills the fields a bill needs to read as a receipt — Bill.billNumber, tableId /
// tableNumber, type, guest/waiter attribution, openedAt / closedAt, discountTotal and the
// restaurantSnapshot — onto bills raised before services/billing.service.js started
// writing them.
//
// The read path (services/billView.service.js) resolves the table, session and restaurant
// live as a fallback, so nothing is broken without this. What the fallback cannot do is
// survive the underlying record changing: a renamed or deleted table, a restaurant that
// re-registers under a new GSTIN, or a session that is purged all take the historical
// bill's own details with them. Snapshotting closes that.
//
//   node scripts/backfillBillDetails.js            # report only, writes nothing
//   node scripts/backfillBillDetails.js --apply    # write the changes
//
// Safe to re-run: every field is written only where it is still missing, and billNumber
// is allocated in bill-creation order so the resulting series matches the order the bills
// were actually raised in.

import 'dotenv/config';
import mongoose from 'mongoose';
import Bill from '../models/Bill.js';
import Order from '../models/Order.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import Restaurant from '../models/Restaurant.js';
import StaffMember from '../models/StaffMember.js';
import Counter from '../models/Counter.js';

const apply = process.argv.includes('--apply');

const idStr = (v) => (v == null ? null : String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);

  // Oldest first: billNumber is a running series, so it has to be allocated in the order
  // the bills were raised.
  const bills = await Bill.find({
    $or: [
      { billNumber: null },
      { tableNumber: null },
      { restaurantSnapshot: null },
      { type: { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${bills.length} bill(s) missing receipt details`);
  if (bills.length === 0) return;

  const sessions = await TableSession.find({
    _id: { $in: [...new Set(bills.map((b) => idStr(b.tableSessionId)).filter(Boolean))] },
  })
    .select('tableId waiterId guestCount guestPhone openedAt closedAt')
    .lean();
  const sessionById = new Map(sessions.map((s) => [idStr(s._id), s]));

  const orders = await Order.find({
    _id: { $in: [...new Set(bills.map((b) => idStr(b.orderId)).filter(Boolean))] },
  })
    .select('type tableId tableNumber userId deliveryAddress createdAt deliveredAt')
    .lean();
  const orderById = new Map(orders.map((o) => [idStr(o._id), o]));

  const tables = await Table.find({
    _id: {
      $in: [
        ...new Set(
          [
            ...bills.map((b) => b.tableId),
            ...sessions.map((s) => s.tableId),
            ...orders.map((o) => o.tableId),
          ]
            .filter(Boolean)
            .map(String)
        ),
      ],
    },
  })
    .select('identifier')
    .lean();
  const tableById = new Map(tables.map((t) => [idStr(t._id), t]));

  const restaurants = await Restaurant.find({
    _id: { $in: [...new Set(bills.map((b) => idStr(b.restaurantId)))] },
  })
    .select('name logo phone email address settings')
    .lean();
  const restaurantById = new Map(restaurants.map((r) => [idStr(r._id), r]));

  const staffMembers = await StaffMember.find({
    _id: { $in: [...new Set(sessions.map((s) => idStr(s.waiterId)).filter(Boolean))] },
  })
    .select('name')
    .lean();
  const staffById = new Map(staffMembers.map((s) => [idStr(s._id), s]));

  // Continue each restaurant's series from wherever it already stands, so a restaurant
  // that has issued numbered bills since this field was added does not get duplicates.
  const seqByRestaurant = new Map();
  for (const restaurantId of new Set(bills.map((b) => idStr(b.restaurantId)))) {
    const counter = await Counter.findById(`bill:${restaurantId}`).lean();
    seqByRestaurant.set(restaurantId, counter?.seq ?? 0);
  }

  const writes = [];
  let unresolvableTable = 0;

  for (const bill of bills) {
    const set = {};
    const session = sessionById.get(idStr(bill.tableSessionId)) ?? null;
    const order = orderById.get(idStr(bill.orderId)) ?? null;
    const restaurant = restaurantById.get(idStr(bill.restaurantId)) ?? null;

    if (!bill.type) set.type = order?.type ?? 'dine_in';

    const tableId = bill.tableId ?? session?.tableId ?? order?.tableId ?? null;
    if (!bill.tableId && tableId) set.tableId = tableId;
    if (!bill.tableNumber) {
      const identifier = tableById.get(idStr(tableId))?.identifier ?? order?.tableNumber ?? null;
      if (identifier) set.tableNumber = identifier;
      else if (bill.tableSessionId) unresolvableTable += 1;
    }

    if (bill.guestCount == null && session?.guestCount != null) set.guestCount = session.guestCount;
    if (!bill.guestPhone && session?.guestPhone) set.guestPhone = session.guestPhone;
    if (!bill.waiterId && session?.waiterId) {
      set.waiterId = session.waiterId;
      const waiter = staffById.get(idStr(session.waiterId));
      if (waiter?.name) set.waiterName = waiter.name;
    }
    if (!bill.customerId && order?.userId) set.customerId = order.userId;
    if (!bill.deliveryAddress?.street && order?.deliveryAddress?.street) {
      set.deliveryAddress = {
        street: order.deliveryAddress.street ?? null,
        city: order.deliveryAddress.city ?? null,
      };
    }

    if (!bill.openedAt) {
      set.openedAt = session?.openedAt ?? order?.createdAt ?? bill.createdAt ?? null;
    }
    if (!bill.closedAt) {
      const closed = session?.closedAt ?? order?.deliveredAt ?? bill.paidAt ?? null;
      if (closed) set.closedAt = closed;
    }

    // A reconstruction, not a true issue-time snapshot: these are the restaurant's details
    // as they stand today, which is the best that is recoverable for a historical bill.
    if (!bill.restaurantSnapshot?.name && restaurant) {
      set.restaurantSnapshot = {
        name: restaurant.name ?? null,
        legalName: restaurant.settings?.ownerName ?? null,
        logo: restaurant.logo ?? null,
        phone: restaurant.phone ?? null,
        email: restaurant.email ?? null,
        gstNumber: restaurant.settings?.gstNumber ?? null,
        panNumber: restaurant.settings?.panNumber ?? null,
        fssaiNumber: restaurant.settings?.healthPermitId ?? null,
        address: {
          street: restaurant.address?.street ?? null,
          city: restaurant.address?.city ?? null,
          state: restaurant.address?.state ?? null,
          pincode: restaurant.address?.pincode ?? null,
        },
      };
    }

    if (bill.discountTotal == null) {
      set.discountTotal = round2(
        (bill.discountsApplied ?? []).reduce((s, d) => s + (d.amount ?? 0), 0)
      );
    }

    if (!bill.billNumber) {
      const key = idStr(bill.restaurantId);
      const seq = (seqByRestaurant.get(key) ?? 0) + 1;
      seqByRestaurant.set(key, seq);
      set.billNumber = `INV-${String(seq).padStart(6, '0')}`;
    }

    if (Object.keys(set).length === 0) continue;
    writes.push({ updateOne: { filter: { _id: bill._id }, update: { $set: set } } });
  }

  console.log(
    `${writes.length} bill(s) to update; ${unresolvableTable} dine-in bill(s) still without a resolvable table`
  );

  if (apply && writes.length > 0) {
    const res = await Bill.bulkWrite(writes, { ordered: false });
    console.log(`modified ${res.modifiedCount}`);

    // Move each restaurant's counter past the numbers just handed out, so the next live
    // bill continues the series instead of colliding with a backfilled one.
    for (const [restaurantId, seq] of seqByRestaurant) {
      await Counter.updateOne(
        { _id: `bill:${restaurantId}` },
        { $max: { seq } },
        { upsert: true }
      );
    }
    console.log(`bill-number counters advanced for ${seqByRestaurant.size} restaurant(s)`);
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
