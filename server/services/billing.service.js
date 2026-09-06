import Bill from '../models/Bill.js';
import TableSession from '../models/TableSession.js';
import Table from '../models/Table.js';
import Order from '../models/Order.js';
import Discount from '../models/Discount.js';
import Restaurant from '../models/Restaurant.js';
import StaffMember from '../models/StaffMember.js';
import User from '../models/User.js';
import { nextSequence } from '../models/Counter.js';
import * as discountService from './discount.service.js';
import { ApiError } from '../utils/ApiError.js';
import { notifyService } from './notify.service.js';

// Rupees, to the paisa. Percentage maths on floats produces figures like
// 37.500000000000004, which then reach the guest's receipt and the revenue aggregates as
// they are. Every money figure this service writes goes through here.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A cancelled round is history — it belongs on the bill's order-history panel so the
// guest can see it was voided, but it must never be charged for.
const isBilledOrder = (order) => order?.status !== 'cancelled';

// A round the floor has finished with: carried to the table ('served'), or 'delivered' —
// kept for dine-in rounds closed out before 'served' existed as a state.
const SERVED_ROUND_STATUSES = new Set(['served', 'delivered']);

/**
 * The rounds on a session that have not reached the table yet.
 *
 * A cancelled round is already off the bill (isBilledOrder) and never holds it open; a
 * round still in the kitchen does, because what the sitting owes is not final while the
 * kitchen can still void it, re-fire it or have it sent back.
 */
export const pendingRoundsOf = (orders = []) =>
  orders.filter((o) => o && o.status !== 'cancelled' && !SERVED_ROUND_STATUSES.has(o.status));

/**
 * Guard for the two moments a bill stops being a running tab and becomes the final
 * receipt — raising it and settling it. Both go through here so the rule lives in one
 * place rather than being restated (and drifting) per portal.
 *
 * Reading a running tab is deliberately NOT guarded: the guest's bill screen and the
 * owner console show a sitting as it stands, pending rounds and all.
 */
export const assertSessionFullyServed = async (tableSessionId) => {
  const session = await TableSession.findById(tableSessionId).populate('orders').lean();
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Session not found');

  const pending = pendingRoundsOf(session.orders);
  if (pending.length) {
    throw new ApiError(
      409,
      'ORDERS_PENDING',
      pending.length === 1
        ? 'One round has not been served yet — the bill can be generated once it reaches the table.'
        : `${pending.length} rounds have not been served yet — the bill can be generated once they reach the table.`,
      {
        pendingCount: pending.length,
        pendingOrders: pending.map((o) => ({
          orderId: o._id,
          batchNumber: o.batchNumber ?? null,
          status: o.status,
        })),
      }
    );
  }

  return session;
};

/**
 * The next receipt number for a restaurant: `INV-000001`, running in issue order and
 * unique per restaurant. Allocated only when a bill is actually created, never on a
 * re-assemble, so the series has no gaps.
 */
const nextBillNumber = async (restaurantId) => {
  const seq = await nextSequence(`bill:${restaurantId}`);
  return `INV-${String(seq).padStart(6, '0')}`;
};

// The issuing restaurant's details as they stood when the bill was raised. Copied onto
// every bill because a receipt has to survive the restaurant being renamed, moved,
// re-registered under a new GSTIN, or removed from the platform.
const restaurantSnapshotOf = (restaurant) => ({
  name: restaurant?.name ?? null,
  legalName: restaurant?.settings?.ownerName ?? null,
  logo: restaurant?.logo ?? null,
  phone: restaurant?.phone ?? null,
  email: restaurant?.email ?? null,
  gstNumber: restaurant?.settings?.gstNumber ?? null,
  panNumber: restaurant?.settings?.panNumber ?? null,
  // 'FSSAI License No.' in the store-settings contract — see config/storeSettings.config.js.
  fssaiNumber: restaurant?.settings?.healthPermitId ?? null,
  address: {
    street: restaurant?.address?.street ?? null,
    city: restaurant?.address?.city ?? null,
    state: restaurant?.address?.state ?? null,
    pincode: restaurant?.address?.pincode ?? null,
  },
});

const batchOf = (order, staffById) => {
  const staff = order.staffId ? staffById.get(String(order.staffId)) : null;
  return {
    batchNumber: order.batchNumber,
    orderId: order._id,
    items: (order.items ?? []).map((i) => ({
      menuItemId: i.menuItemId ?? null,
      name: i.name,
      quantity: i.quantity,
      price: round2(i.price),
      lineTotal: round2(i.price * i.quantity),
      note: i.note ?? '',
    })),
    batchTotal: round2(order.subtotal),
    placedAt: order.createdAt,
    status: order.status,
    placedBy: order.placedBy ?? null,
    staffId: order.staffId ?? null,
    staffName: staff?.name ?? null,
  };
};

/**
 * Totals a dine-in bill. `discountTotal` is passed in rather than re-derived so this is
 * the one place the arithmetic lives, whether the caller is assembling a fresh bill or
 * re-totalling one after a discount was applied.
 *
 * GST and service charge are both levied on the pre-discount item subtotal, which is what
 * the restaurant's settings describe (`gstPercent`, `serviceChargePercent`); the discount
 * comes off the final payable.
 */
const totalsFor = ({ subtotal, gstPercent, serviceChargePercent, discountTotal = 0 }) => {
  const gstAmount = round2(subtotal * ((gstPercent ?? 0) / 100));
  const serviceChargeAmount = round2(subtotal * ((serviceChargePercent ?? 0) / 100));
  return {
    subtotal: round2(subtotal),
    gstPercent: gstPercent ?? 0,
    gstAmount,
    serviceChargePercent: serviceChargePercent ?? 0,
    serviceChargeAmount,
    discountTotal: round2(discountTotal),
    grandTotal: round2(subtotal + gstAmount + serviceChargeAmount - discountTotal),
  };
};

/**
 * Builds (or refreshes) the bill for a dine-in table session.
 *
 * Idempotent, and deliberately frozen once settled: the guest-facing GET and the waiter's
 * bill panel both call this on every open, and a paid receipt must not be silently
 * re-priced afterwards by a later menu change, a renamed table, or a cancelled round.
 */
export const assembleBill = async (tableSessionId) => {
  const session = await TableSession.findById(tableSessionId).populate('orders').lean();
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Session not found');

  const existing = await Bill.findOne({ tableSessionId });
  // A settled bill is a record, not a live document — hand it straight back.
  if (existing && existing.status !== 'open') return existing;

  const orders = [...(session.orders ?? [])].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  const staffIds = [
    ...new Set(orders.map((o) => o.staffId).filter(Boolean).map(String)),
    ...(session.waiterId ? [String(session.waiterId)] : []),
  ];
  const customerUserId = orders.find((o) => o.userId)?.userId ?? null;
  // The first order of the sitting that named anyone. Orders now snapshot the customer at
  // placement (Order.customerName/customerPhone), so the receipt takes the same answer the
  // kitchen ticket and the owner's order list already show, instead of independently
  // re-deriving one and risking a bill that disagrees with the order it came from.
  const namedOrder = orders.find((o) => o.customerName || o.customerPhone) ?? null;

  const [restaurant, table, staffMembers, customer] = await Promise.all([
    Restaurant.findById(session.restaurantId).lean(),
    session.tableId ? Table.findById(session.tableId).select('identifier capacity').lean() : null,
    staffIds.length
      ? StaffMember.find({ _id: { $in: staffIds } }).select('name role staffCode').lean()
      : [],
    // A signed-in customer ordering from the table QR — named on the receipt the same way
    // a delivery customer is. Guests who never signed in have only session.guestPhone.
    customerUserId ? User.findById(customerUserId).select('name phone').lean() : null,
  ]);
  const staffById = new Map(staffMembers.map((s) => [String(s._id), s]));

  const batches = orders.map((o) => batchOf(o, staffById));
  const subtotal = batches
    .filter((_, i) => isBilledOrder(orders[i]))
    .reduce((sum, b) => sum + b.batchTotal, 0);

  // Discounts already applied to this bill survive a re-assemble. Recomputing the total
  // without them used to silently un-apply every discount the moment anything re-read the
  // bill — which every bill screen does on open.
  const discountsApplied = existing?.discountsApplied ?? [];
  const discountTotal = discountsApplied.reduce((s, d) => s + (d.amount ?? 0), 0);

  const waiter = session.waiterId ? staffById.get(String(session.waiterId)) : null;

  const fields = {
    restaurantId: session.restaurantId,
    tableSessionId,
    type: 'dine_in',
    tableId: session.tableId ?? null,
    tableNumber: table?.identifier ?? null,
    guestCount: session.guestCount ?? null,
    guestPhone: session.guestPhone ?? null,
    customerId: customer?._id ?? null,
    customerName: namedOrder?.customerName ?? customer?.name ?? session.guestName ?? null,
    customerPhone:
      namedOrder?.customerPhone ?? customer?.phone ?? session.guestPhone ?? null,
    waiterId: session.waiterId ?? null,
    waiterName: waiter?.name ?? null,
    openedAt: session.openedAt ?? null,
    closedAt: session.closedAt ?? null,
    restaurantSnapshot: restaurantSnapshotOf(restaurant),
    batches,
    ...totalsFor({
      subtotal,
      gstPercent: restaurant?.settings?.gstPercent,
      serviceChargePercent: restaurant?.settings?.serviceChargePercent,
      discountTotal,
    }),
  };

  let bill;
  if (existing) {
    existing.set(fields);
    bill = await existing.save();
  } else {
    bill = await Bill.create({
      ...fields,
      billNumber: await nextBillNumber(session.restaurantId),
    });
  }

  notifyService.billUpdated({ ...bill.toObject(), tableId: session.tableId });
  return bill;
};

// Dine-in bills are assembled from a TableSession (assembleBill above); delivery/takeaway
// orders have no session to batch into, so they get their own single-order bill once the
// order reaches a terminal 'delivered' state (see kitchen.service.updateOrderStatus).
//
// The money here is COPIED from the order, never recomputed: checkout froze
// subtotal/deliveryFee/platformFee/tax/tip/discountAmount/grandTotal at placement, and the
// customer has already been charged that grandTotal. Re-deriving GST and a service charge
// from the restaurant's dine-in settings produced a receipt whose total did not match what
// was actually taken from the customer, and silently dropped the delivery fee.
export const createOrderBill = async (order) => {
  // Both the kitchen and the delivery-partner side can drive an order to 'delivered'
  // (see kitchen.service.js and controllers/partner/order.controller.js) — one order must
  // still only ever produce one receipt.
  const existing = await Bill.findOne({ orderId: order._id });
  if (existing) return existing;

  // Only for orders placed before the customer snapshot existed — see the same fallback
  // in services/deliveryAssignment.service.js's buildOfferPayload.
  const needsUserLookup = order.userId && !order.customerName && !order.customerPhone;
  const [restaurant, customer] = await Promise.all([
    Restaurant.findById(order.restaurantId).lean(),
    needsUserLookup ? User.findById(order.userId).select('name phone').lean() : null,
  ]);

  const subtotal = round2(order.subtotal);
  const discountTotal = round2(order.discountAmount ?? 0);
  const tax = round2(order.tax ?? 0);
  const deliveryFee = round2(order.deliveryFee ?? 0);
  const platformFee = round2(order.platformFee ?? 0);
  const tip = round2(order.tip ?? 0);
  // Orders placed before grandTotal was frozen on the model have none — fall back to the
  // same sum checkout uses rather than shipping a bill with a null total.
  const grandTotal = round2(
    order.grandTotal ?? subtotal + deliveryFee + platformFee + tax + tip - discountTotal
  );

  return Bill.create({
    restaurantId: order.restaurantId,
    billNumber: await nextBillNumber(order.restaurantId),
    orderId: order._id,
    type: order.type,
    tableId: order.tableId ?? null,
    tableNumber: order.tableNumber ?? null,
    customerId: order.userId ?? customer?._id ?? null,
    customerName: order.customerName ?? customer?.name ?? null,
    customerPhone: order.customerPhone ?? customer?.phone ?? null,
    deliveryAddress: {
      street: order.deliveryAddress?.street ?? null,
      city: order.deliveryAddress?.city ?? null,
    },
    openedAt: order.createdAt ?? null,
    closedAt: order.deliveredAt ?? new Date(),
    restaurantSnapshot: restaurantSnapshotOf(restaurant),
    batches: [batchOf(order, new Map())],
    subtotal,
    // A delivery order is taxed by the platform's own cart tax (config/finance.config.js),
    // already included in order.tax — the restaurant's dine-in gstPercent does not apply,
    // so the rate is reported as the one actually charged rather than the dine-in figure.
    gstPercent: subtotal > 0 ? round2((tax / subtotal) * 100) : 0,
    gstAmount: tax,
    serviceChargePercent: 0,
    serviceChargeAmount: 0,
    deliveryFee,
    platformFee,
    tip,
    discountsApplied: discountTotal
      ? [
          {
            discountId: order.appliedDiscountId ?? null,
            code: null,
            description: 'Order discount',
            amount: discountTotal,
          },
        ]
      : [],
    discountTotal,
    grandTotal,
    status: 'paid',
    paidAt: new Date(),
    paidBy: order.paymentMethod ?? 'cash',
    razorpayPaymentId: order.razorpayPaymentId ?? null,
    paymentIntentId: order.paymentIntentId ?? null,
  });
};

export const applyDiscount = async ({ billId, discountCode, restaurantId }) => {
  const bill = await Bill.findById(billId);
  if (!bill || bill.status !== 'open') {
    throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  }

  const discount = await Discount.findOne({ code: discountCode, restaurantId });
  // orderType: 'dine_in' — this is a new check (see discount.service.js's comment); a
  // delivery-only discount now correctly gets rejected here instead of silently applying.
  discountService.validateDiscountForOrder(discount, { subtotal: bill.subtotal, orderType: 'dine_in' });

  const deduction = await discountService.computeDiscountAmount(discount, bill.subtotal);

  bill.discountsApplied.push({
    discountId: discount._id,
    code: discount.code,
    description: discount.offerName,
    amount: round2(deduction),
  });

  bill.set(
    totalsFor({
      subtotal: bill.subtotal,
      gstPercent: bill.gstPercent,
      serviceChargePercent: bill.serviceChargePercent,
      discountTotal: bill.discountsApplied.reduce((s, d) => s + (d.amount ?? 0), 0),
    })
  );

  await bill.save();
  return bill;
};

export const markPaid = async ({ billId, restaurantId, paymentMethod }) => {
  const bill = await Bill.findOne({ _id: billId, restaurantId, status: 'open' });
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found or already settled');

  const now = new Date();
  bill.status = 'paid';
  bill.paidAt = now;
  bill.paidBy = paymentMethod;
  // The sitting ends when the bill is settled — recorded on the bill itself so the receipt
  // can state the period it covers without joining back to a session that may be reused.
  bill.closedAt = now;
  await bill.save();

  const [session] = await Promise.all([
    TableSession.findByIdAndUpdate(
      bill.tableSessionId,
      { status: 'paid', closedAt: now },
      { new: false }
    ),
    Order.updateMany(
      { tableSessionId: bill.tableSessionId, paymentStatus: 'pending' },
      { $set: { paymentStatus: 'paid', paymentMethod } }
    ),
  ]);

  if (session?.tableId) {
    const table = await Table.findById(session.tableId).lean();
    if (table) notifyService.tableStatusChanged(restaurantId, table, 'paid');
  }

  return bill;
};
