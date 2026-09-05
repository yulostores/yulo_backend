import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import StaffMember from '../models/StaffMember.js';

// Read-side shaping for orders. An Order row on its own answers "what was ordered" but
// not the two questions every order screen actually asks first — WHICH TABLE is this for,
// and WHO took it. Both are resolvable (tableId/tableNumber/staffId are on the order, the
// session knows its assigned waiter), but every screen was left to do that join itself and
// none of them did. This module does it once, for all of them.
//
// It also repairs history: orders placed before Order.tableId/tableNumber were populated
// have neither field set, so the table is resolved through tableSessionId -> TableSession
// -> Table as a fallback. That keeps existing orders readable without requiring the
// backfill script (scripts/backfillOrderTableInfo.js) to have been run first.

const idStr = (v) => (v == null ? null : String(v));

const uniqueIds = (values) => [...new Set(values.filter(Boolean).map(String))];

/**
 * Attaches `table`, `staff`, `waiter` and `session` to a list of lean order documents.
 * Runs three batched lookups regardless of how many orders come in — never per-order.
 */
export const enrichOrders = async (orders = []) => {
  if (orders.length === 0) return [];

  const sessionIds = uniqueIds(orders.map((o) => o.tableSessionId));
  const sessions = sessionIds.length
    ? await TableSession.find({ _id: { $in: sessionIds } })
        .select('tableId waiterId status openedAt closedAt guestCount batchCount')
        .lean()
    : [];
  const sessionById = new Map(sessions.map((s) => [idStr(s._id), s]));

  const tableIds = uniqueIds([
    ...orders.map((o) => o.tableId),
    ...sessions.map((s) => s.tableId),
  ]);
  const tables = tableIds.length
    ? await Table.find({ _id: { $in: tableIds } }).select('identifier capacity').lean()
    : [];
  const tableById = new Map(tables.map((t) => [idStr(t._id), t]));

  const staffIds = uniqueIds([
    ...orders.map((o) => o.staffId),
    ...orders.flatMap((o) => (o.statusHistory ?? []).map((h) => h.byStaffId)),
    ...sessions.map((s) => s.waiterId),
  ]);
  const staffMembers = staffIds.length
    ? await StaffMember.find({ _id: { $in: staffIds } }).select('name role staffCode').lean()
    : [];
  const staffById = new Map(staffMembers.map((m) => [idStr(m._id), m]));

  const toStaff = (id) => {
    const m = staffById.get(idStr(id));
    if (!m) return null;
    return { _id: m._id, name: m.name, role: m.role, staffCode: m.staffCode };
  };

  return orders.map((order) => {
    const session = sessionById.get(idStr(order.tableSessionId)) ?? null;
    // order.tableId first (set at placement), session.tableId as the legacy fallback.
    const table = tableById.get(idStr(order.tableId ?? session?.tableId)) ?? null;

    return {
      ...order,
      tableId: order.tableId ?? session?.tableId ?? null,
      tableNumber: order.tableNumber ?? table?.identifier ?? null,
      table: table
        ? { _id: table._id, identifier: table.identifier, capacity: table.capacity }
        : null,
      // Who actually rang the order in (null for guest QR and customer app orders —
      // `placedBy` is what tells those two apart).
      staff: toStaff(order.staffId),
      // The waiter assigned to the table for the whole sitting. For a waiter-placed order
      // this is usually the same person as `staff`; for a guest QR order it is the only
      // staff attribution that exists.
      waiter: toStaff(session?.waiterId),
      session: session
        ? {
            _id: session._id,
            status: session.status,
            openedAt: session.openedAt,
            closedAt: session.closedAt,
            guestCount: session.guestCount,
            batchCount: session.batchCount,
          }
        : null,
      statusHistory: (order.statusHistory ?? []).map((h) => ({
        ...h,
        staff: h.byStaffName ? { name: h.byStaffName, role: h.byRole } : toStaff(h.byStaffId),
      })),
    };
  });
};

export const enrichOrder = async (order) => {
  if (!order) return order;
  const [enriched] = await enrichOrders([order]);
  return enriched;
};

// Statuses that mean "this order is still in play" — used to decide whether a table is
// currently active and to compute a table's headline status.
const OPEN_STATUSES = ['placed', 'confirmed', 'preparing', 'ready'];

// Ordered furthest-behind first: a table showing four tickets is described by its slowest
// one, since that's the one the floor still has to chase.
const STATUS_RANK = ['placed', 'confirmed', 'preparing', 'ready', 'served', 'delivered'];

const headlineStatus = (orders) => {
  const live = orders.filter((o) => o.status !== 'cancelled');
  if (live.length === 0) return orders.length > 0 ? 'cancelled' : 'placed';
  return live.reduce((worst, o) => {
    const a = STATUS_RANK.indexOf(worst);
    const b = STATUS_RANK.indexOf(o.status);
    return b >= 0 && (a < 0 || b < a) ? o.status : worst;
  }, live[0].status);
};

// Splits one table's orders into the sittings they belong to, newest sitting first and
// rounds within a sitting oldest first (the order they were cooked and carried).
const buildSittings = (orders, openSession) => {
  const bySession = new Map();

  for (const order of orders) {
    // An order with no session at all (a data-integrity edge, not a normal path) still
    // has to appear — it gets its own single-order sitting rather than being dropped.
    const key = idStr(order.tableSessionId) ?? `orphan:${idStr(order._id)}`;
    if (!bySession.has(key)) {
      bySession.set(key, {
        sessionId: order.tableSessionId ?? null,
        status: order.session?.status ?? null,
        openedAt: order.session?.openedAt ?? order.createdAt,
        closedAt: order.session?.closedAt ?? null,
        guestCount: order.session?.guestCount ?? null,
        waiter: order.waiter ?? null,
        orders: [],
      });
    }
    bySession.get(key).orders.push(order);
  }

  // A table that's occupied but hasn't ordered yet still has a sitting to show.
  if (openSession && !bySession.has(idStr(openSession._id))) {
    bySession.set(idStr(openSession._id), {
      sessionId: openSession._id,
      status: openSession.status,
      openedAt: openSession.openedAt,
      closedAt: null,
      guestCount: openSession.guestCount ?? null,
      waiter: openSession.waiter ?? null,
      orders: [],
    });
  }

  return [...bySession.values()]
    .map((sitting) => {
      const live = sitting.orders.filter((o) => o.status !== 'cancelled');
      return {
        ...sitting,
        subtotal: live.reduce((sum, o) => sum + (o.subtotal ?? 0), 0),
        itemCount: live.reduce(
          (sum, o) => sum + (o.items ?? []).reduce((n, i) => n + (i.quantity ?? 0), 0),
          0
        ),
        status: headlineStatus(sitting.orders),
        isOpen: sitting.status === 'open' || sitting.status === 'bill_requested',
      };
    })
    .sort((a, b) => new Date(b.openedAt ?? 0) - new Date(a.openedAt ?? 0));
};

/**
 * Dine-in orders grouped table -> sitting -> rounds, which is the shape the floor
 * actually thinks in and the shape the owner's Manage Orders screen renders.
 *
 * scope:
 *   'active' (default) — only tables with an order still open, or an open session
 *   'today'            — every table that saw an order since midnight
 *   'all'              — every dine-in order this restaurant has ever taken
 */
export const getOrdersByTable = async ({ restaurantId, scope = 'active', search = '' }) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);
  const filter = { restaurantId: rid, type: 'dine_in' };

  if (scope === 'today') {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    filter.createdAt = { $gte: startOfToday };
  } else if (scope === 'active') {
    // An order still moving, OR anything belonging to a session that hasn't been paid
    // out yet — a table whose food is all served but whose bill is still open is very
    // much still a live table to the floor.
    const openSessionIds = await TableSession.find({
      restaurantId: rid,
      status: { $in: ['open', 'bill_requested'] },
    })
      .select('_id')
      .lean();
    filter.$or = [
      { status: { $in: OPEN_STATUSES } },
      { tableSessionId: { $in: openSessionIds.map((s) => s._id) } },
    ];
  }

  const orders = await Order.find(filter).sort({ createdAt: 1 }).lean();
  const enriched = await enrichOrders(orders);

  // Every active table is listed even when it has no orders yet — an occupied table that
  // hasn't ordered is information the floor needs, not an empty row to hide.
  const [tables, openSessions] = await Promise.all([
    Table.find({ restaurantId: rid, isActive: true }).select('identifier capacity').lean(),
    TableSession.find({ restaurantId: rid, status: { $in: ['open', 'bill_requested'] } })
      .select('tableId waiterId status openedAt guestCount batchCount')
      .lean(),
  ]);
  const sessionByTableId = new Map(openSessions.map((s) => [idStr(s.tableId), s]));

  const waiterIds = uniqueIds(openSessions.map((s) => s.waiterId));
  const waiters = waiterIds.length
    ? await StaffMember.find({ _id: { $in: waiterIds } }).select('name role staffCode').lean()
    : [];
  const waiterById = new Map(waiters.map((w) => [idStr(w._id), w]));

  const groups = new Map();
  const ensureGroup = (key, seed) => {
    if (!groups.has(key)) groups.set(key, { ...seed, orders: [] });
    return groups.get(key);
  };

  for (const table of tables) {
    const key = idStr(table._id);
    const session = sessionByTableId.get(key) ?? null;
    // In 'active' scope a table with no open sitting is only interesting if an order
    // pulls it in below; seeding it here would fill the screen with empty tables.
    if (!session && scope === 'active') continue;
    ensureGroup(key, {
      tableId: table._id,
      tableNumber: table.identifier,
      capacity: table.capacity ?? null,
      session: session
        ? {
            _id: session._id,
            status: session.status,
            openedAt: session.openedAt,
            guestCount: session.guestCount,
            batchCount: session.batchCount,
            waiter: waiterById.get(idStr(session.waiterId)) ?? null,
          }
        : null,
    });
  }

  for (const order of enriched) {
    // An order whose table row was deleted still has to appear somewhere — key it by its
    // snapshotted tableNumber rather than dropping it on the floor.
    const key = idStr(order.tableId) ?? `unknown:${order.tableNumber ?? 'na'}`;
    const group = ensureGroup(key, {
      tableId: order.tableId ?? null,
      tableNumber: order.tableNumber ?? 'Unassigned',
      capacity: order.table?.capacity ?? null,
      session: null,
    });
    group.orders.push(order);
  }

  const term = search.trim().toLowerCase();

  return [...groups.values()]
    .filter((g) => g.orders.length > 0 || g.session)
    .filter((g) => {
      if (!term) return true;
      return (
        String(g.tableNumber ?? '').toLowerCase().includes(term) ||
        g.orders.some(
          (o) =>
            String(o._id).toLowerCase().includes(term) ||
            (o.staff?.name ?? '').toLowerCase().includes(term) ||
            (o.items ?? []).some((i) => (i.name ?? '').toLowerCase().includes(term))
        )
      );
    })
    .map((g) => {
      const live = g.orders.filter((o) => o.status !== 'cancelled');
      const lastOrder = g.orders[g.orders.length - 1] ?? null;
      // Rounds are numbered by the session's own batchNumber where there is one, so the
      // numbering matches what the bill and the kitchen tickets already say.
      const orders = g.orders.map((o, i) => ({ ...o, round: o.batchNumber ?? i + 1 }));
      return {
        ...g,
        orders,
        // A table is reused all evening, and batchNumber restarts with each party — so a
        // flat list of a table's orders reads "Round 1, Round 2, Round 1" and the rounds
        // of two different parties sit side by side. Sittings are the missing middle
        // layer: table -> sitting -> rounds, which is what the numbering already assumes.
        sittings: buildSittings(orders, g.session),
        summary: {
          orderCount: g.orders.length,
          itemCount: live.reduce(
            (sum, o) => sum + (o.items ?? []).reduce((n, i) => n + (i.quantity ?? 0), 0),
            0
          ),
          subtotal: live.reduce((sum, o) => sum + (o.subtotal ?? 0), 0),
          status: headlineStatus(g.orders),
          firstOrderAt: g.orders[0]?.createdAt ?? g.session?.openedAt ?? null,
          lastOrderAt: lastOrder?.createdAt ?? null,
          // Names every staff member who touched this table, deduped — the answer to
          // "who is looking after table 4" when rounds were split across two waiters.
          staff: [
            ...new Map(
              g.orders
                .map((o) => o.staff)
                .concat(g.session?.waiter ? [g.session.waiter] : [])
                .filter(Boolean)
                .map((s) => [idStr(s._id), { _id: s._id, name: s.name, role: s.role }])
            ).values(),
          ],
        },
      };
    })
    .sort((a, b) => {
      // Most recently active table first; idle occupied tables sink below active ones.
      const at = new Date(a.summary.lastOrderAt ?? a.session?.openedAt ?? 0).getTime();
      const bt = new Date(b.summary.lastOrderAt ?? b.session?.openedAt ?? 0).getTime();
      return bt - at;
    });
};
