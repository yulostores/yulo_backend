import Bill from '../models/Bill.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import StaffMember from '../models/StaffMember.js';

// Read-side shaping for bills — the single source of the bill payload every portal
// renders. The owner console, the waiter's bill panel, the guest's own "pay the bill"
// screen and the platform admin's bill browser all read this exact object, so a bill says
// the same thing about the same sitting no matter who is looking at it.
//
// Before this existed, each screen invented its own reading of the raw Bill document
// (bill.items / bill.taxRate / bill.paymentMethod — none of which the model has), so the
// owner and waiter bill screens rendered no line items and no tax at all.
//
// It also repairs history: bills raised before the table/session/restaurant snapshots
// existed on the model have none, so those are resolved live through
// tableSessionId -> TableSession -> Table and orderId -> Order. Existing bills therefore
// read correctly without waiting on scripts/backfillBillDetails.js.

const idStr = (v) => (v == null ? null : String(v));

const uniqueIds = (values) => [...new Set(values.filter(Boolean).map(String))];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A short, human, copy-and-read-aloud handle for any record whose own id is an ObjectId.
// Used for a bill with no billNumber yet (pre-numbering history) and for each order in the
// bill's history panel, so every portal prints the identical code for the same record.
const shortCode = (id) => (id ? String(id).slice(-6).toUpperCase() : null);

const CANCELLED = 'cancelled';

const plainBill = (bill) => {
  if (!bill) return null;
  return typeof bill.toObject === 'function' ? bill.toObject() : bill;
};

/**
 * Resolves everything a batch of bills needs in a fixed number of queries, regardless of
 * how many bills come in — never one lookup per bill.
 */
const loadContext = async (bills) => {
  const sessionIds = uniqueIds(bills.map((b) => b.tableSessionId));
  const sessions = sessionIds.length
    ? await TableSession.find({ _id: { $in: sessionIds } })
        .select('tableId waiterId status openedAt closedAt guestCount guestPhone batchCount')
        .lean()
    : [];
  const sessionById = new Map(sessions.map((s) => [idStr(s._id), s]));

  const tableIds = uniqueIds([
    ...bills.map((b) => b.tableId),
    ...sessions.map((s) => s.tableId),
  ]);
  const tables = tableIds.length
    ? await Table.find({ _id: { $in: tableIds } }).select('identifier capacity').lean()
    : [];

  const staffIds = uniqueIds([
    ...bills.map((b) => b.waiterId),
    ...bills.flatMap((b) => (b.batches ?? []).map((batch) => batch.staffId)),
    ...sessions.map((s) => s.waiterId),
  ]);
  const staffMembers = staffIds.length
    ? await StaffMember.find({ _id: { $in: staffIds } }).select('name role staffCode').lean()
    : [];

  // Only for bills whose batches predate the status/placedBy/staff snapshot — a fully
  // snapshotted bill needs no order lookup at all.
  const orderIds = uniqueIds(
    bills.flatMap((b) =>
      (b.batches ?? [])
        .filter((batch) => batch.status == null)
        .map((batch) => batch.orderId)
    )
  );
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } })
        .select('status placedBy staffId batchNumber createdAt tableNumber tableId type')
        .lean()
    : [];

  // Same story for the restaurant header: resolved live only for bills raised before
  // restaurantSnapshot existed.
  const restaurantIds = uniqueIds(
    bills.filter((b) => !b.restaurantSnapshot?.name).map((b) => b.restaurantId)
  );
  const restaurants = restaurantIds.length
    ? await Restaurant.find({ _id: { $in: restaurantIds } })
        .select('name logo phone email address settings')
        .lean()
    : [];

  return {
    sessionById,
    tableById: new Map(tables.map((t) => [idStr(t._id), t])),
    staffById: new Map(staffMembers.map((s) => [idStr(s._id), s])),
    orderById: new Map(orders.map((o) => [idStr(o._id), o])),
    restaurantById: new Map(restaurants.map((r) => [idStr(r._id), r])),
  };
};

const restaurantHeader = (bill, restaurant) => {
  const snapshot = bill.restaurantSnapshot;
  // The snapshot is authoritative — it is what the bill was raised against. The live
  // record only fills in for bills raised before snapshots existed.
  if (snapshot?.name) {
    return {
      _id: bill.restaurantId,
      name: snapshot.name,
      legalName: snapshot.legalName ?? null,
      logo: snapshot.logo ?? null,
      phone: snapshot.phone ?? null,
      email: snapshot.email ?? null,
      gstNumber: snapshot.gstNumber ?? null,
      panNumber: snapshot.panNumber ?? null,
      fssaiNumber: snapshot.fssaiNumber ?? null,
      address: snapshot.address ?? null,
      isSnapshot: true,
    };
  }
  if (!restaurant) return null;
  return {
    _id: restaurant._id,
    name: restaurant.name ?? null,
    legalName: restaurant.settings?.ownerName ?? null,
    logo: restaurant.logo ?? null,
    phone: restaurant.phone ?? null,
    email: restaurant.email ?? null,
    gstNumber: restaurant.settings?.gstNumber ?? null,
    panNumber: restaurant.settings?.panNumber ?? null,
    fssaiNumber: restaurant.settings?.healthPermitId ?? null,
    address: restaurant.address ?? null,
    isSnapshot: false,
  };
};

/**
 * One line per distinct dish across the whole sitting — Butter Chicken ordered in round 1
 * and again in round 3 reads as a single "Butter Chicken × 3" line. This is the receipt
 * view; `batches` below keeps the round-by-round history intact alongside it.
 */
const aggregateItems = (batches) => {
  const lines = new Map();
  for (const batch of batches) {
    if (batch.status === CANCELLED) continue;
    for (const item of batch.items ?? []) {
      const key = `${item.name}::${item.price}`;
      const line = lines.get(key) ?? {
        name: item.name,
        unitPrice: round2(item.price),
        quantity: 0,
        lineTotal: 0,
        notes: [],
      };
      line.quantity += item.quantity ?? 0;
      line.lineTotal = round2(line.lineTotal + (item.lineTotal ?? 0));
      if (item.note) line.notes.push(item.note);
      lines.set(key, line);
    }
  }
  return [...lines.values()];
};

const buildOne = (rawBill, ctx) => {
  const bill = plainBill(rawBill);
  if (!bill) return null;

  const session = ctx.sessionById.get(idStr(bill.tableSessionId)) ?? null;
  const table = ctx.tableById.get(idStr(bill.tableId ?? session?.tableId)) ?? null;
  const waiterId = bill.waiterId ?? session?.waiterId ?? null;
  const waiter = ctx.staffById.get(idStr(waiterId)) ?? null;
  const restaurant = restaurantHeader(bill, ctx.restaurantById.get(idStr(bill.restaurantId)));

  const batches = (bill.batches ?? [])
    .map((batch) => {
      const order = ctx.orderById.get(idStr(batch.orderId)) ?? null;
      const staff = ctx.staffById.get(idStr(batch.staffId ?? order?.staffId)) ?? null;
      return {
        ...batch,
        // `round` is the label every portal prints ("Round 2"); batchNumber is the stored
        // figure, which is missing on the odd legacy order.
        round: batch.batchNumber ?? null,
        orderCode: shortCode(batch.orderId),
        status: batch.status ?? order?.status ?? null,
        placedBy: batch.placedBy ?? order?.placedBy ?? null,
        placedAt: batch.placedAt ?? order?.createdAt ?? null,
        staff: staff ? { _id: staff._id, name: staff.name, role: staff.role } : null,
        staffName: batch.staffName ?? staff?.name ?? null,
        itemCount: (batch.items ?? []).reduce((n, i) => n + (i.quantity ?? 0), 0),
        items: (batch.items ?? []).map((i) => ({ ...i, lineTotal: round2(i.lineTotal) })),
        batchTotal: round2(batch.batchTotal),
      };
    })
    .sort((a, b) => new Date(a.placedAt ?? 0) - new Date(b.placedAt ?? 0));

  const billedBatches = batches.filter((b) => b.status !== CANCELLED);
  const items = aggregateItems(batches);

  const gstAmount = round2(bill.gstAmount);
  const discountTotal = round2(
    bill.discountTotal ?? (bill.discountsApplied ?? []).reduce((s, d) => s + (d.amount ?? 0), 0)
  );

  // Table number is the field this whole view exists for: it is what the guest, the
  // waiter, the owner and the platform admin all identify a dine-in bill by. Snapshot
  // first, then the table record, then the session's table — so it is present whichever
  // of those a given bill happens to carry.
  const tableNumber = bill.tableNumber ?? table?.identifier ?? null;

  return {
    ...bill,
    billNumber: bill.billNumber ?? null,
    // Always present, even for a bill raised before numbering existed — screens need
    // something stable to title the bill with.
    reference: bill.billNumber ?? `#${shortCode(bill._id)}`,
    type: bill.type ?? (bill.tableSessionId ? 'dine_in' : 'delivery'),

    tableNumber,
    table: table
      ? { _id: table._id, identifier: table.identifier, capacity: table.capacity ?? null }
      : tableNumber
        ? { _id: bill.tableId ?? null, identifier: tableNumber, capacity: null }
        : null,

    session: session
      ? {
          _id: session._id,
          status: session.status,
          openedAt: session.openedAt,
          closedAt: session.closedAt,
          guestCount: session.guestCount,
          guestPhone: session.guestPhone ?? null,
          batchCount: session.batchCount,
        }
      : bill.tableSessionId
        ? { _id: bill.tableSessionId, status: null, openedAt: bill.openedAt, closedAt: bill.closedAt }
        : null,
    sessionCode: shortCode(bill.tableSessionId),

    waiter: waiter
      ? { _id: waiter._id, name: waiter.name, role: waiter.role, staffCode: waiter.staffCode }
      : bill.waiterName
        ? { _id: bill.waiterId ?? null, name: bill.waiterName, role: 'waiter', staffCode: null }
        : null,
    // Whoever the bill is made out to. A walk-in guest who never signed in has only a
    // phone number (captured at QR ordering), which is still the only way to reach them
    // about this receipt.
    customer:
      bill.customerName || bill.customerPhone || bill.guestPhone
        ? {
            _id: bill.customerId ?? null,
            name: bill.customerName ?? null,
            phone: bill.customerPhone ?? bill.guestPhone ?? null,
          }
        : null,
    guestCount: bill.guestCount ?? session?.guestCount ?? null,
    restaurant,

    openedAt: bill.openedAt ?? session?.openedAt ?? batches[0]?.placedAt ?? bill.createdAt,
    closedAt: bill.closedAt ?? session?.closedAt ?? bill.paidAt ?? null,

    batches,
    items,
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    orderCount: billedBatches.length,
    cancelledOrderCount: batches.length - billedBatches.length,

    charges: {
      subtotal: round2(bill.subtotal),
      discountTotal,
      gstPercent: bill.gstPercent ?? 0,
      gstAmount,
      // An Indian restaurant bill states GST as its two intra-state halves. Both are
      // derived from the single gstPercent the restaurant configures — there is no
      // separate CGST/SGST setting to read, and no rate is assumed here.
      cgstPercent: round2((bill.gstPercent ?? 0) / 2),
      cgstAmount: round2(gstAmount / 2),
      sgstPercent: round2((bill.gstPercent ?? 0) / 2),
      sgstAmount: round2(gstAmount - round2(gstAmount / 2)),
      serviceChargePercent: bill.serviceChargePercent ?? 0,
      serviceChargeAmount: round2(bill.serviceChargeAmount),
      deliveryFee: round2(bill.deliveryFee),
      platformFee: round2(bill.platformFee),
      tip: round2(bill.tip),
      grandTotal: round2(bill.grandTotal),
    },
    discountsApplied: (bill.discountsApplied ?? []).map((d) => ({
      ...d,
      amount: round2(d.amount),
    })),

    payment: {
      status: bill.status,
      isPaid: bill.status === 'paid',
      method: bill.paidBy ?? null,
      paidAt: bill.paidAt ?? null,
      // The Razorpay ids, surfaced so a guest disputing a charge and the owner looking at
      // the same bill quote the same reference.
      transactionId: bill.razorpayPaymentId ?? null,
      intentId: bill.paymentIntentId ?? null,
    },
    // Kept for callers that read the flat field — same value as payment.method.
    paymentMethod: bill.paidBy ?? null,
  };
};

/** Shapes a list of bills (lean documents or mongoose documents) for any portal. */
export const buildBillViews = async (bills = []) => {
  const raw = bills.map(plainBill).filter(Boolean);
  if (raw.length === 0) return [];
  const ctx = await loadContext(raw);
  return raw.map((bill) => buildOne(bill, ctx));
};

/** Shapes a single bill. */
export const buildBillView = async (bill) => {
  if (!bill) return null;
  const [view] = await buildBillViews([bill]);
  return view ?? null;
};

/**
 * The bill covering a given order, from either side of the model: a delivery/takeaway
 * order owns its bill outright (Bill.orderId), a dine-in order is one round inside its
 * table session's bill (Bill.tableSessionId). Returns null when the order has no bill yet
 * — a dine-in sitting that has not been settled or opened on a bill screen has none.
 */
export const findBillForOrder = async ({ orderId, restaurantId }) => {
  const order = await Order.findOne({ _id: orderId, restaurantId })
    .select('tableSessionId')
    .lean();
  if (!order) return { order: null, bill: null };

  const bill = await Bill.findOne({
    restaurantId,
    ...(order.tableSessionId
      ? { tableSessionId: order.tableSessionId }
      : { orderId: order._id }),
  }).lean();

  return { order, bill: bill ? await buildBillView(bill) : null };
};
