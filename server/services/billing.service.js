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
import { getActiveSettings } from './financeSettings.service.js';
import { computeCustomerCharges } from './charges.service.js';
import { percentOf, toPaise, toRupees } from '../utils/money.js';
import { onBillPaid } from './ledger.service.js';
import { flagCancelledPaidDineInRound } from './refund.service.js';
import logger from '../utils/logger.js';

// Rupees, to the paisa. Percentage maths on floats produces figures like
// 37.500000000000004, which then reach the guest's receipt and the revenue aggregates as
// they are. Every money figure this service writes goes through here.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A cancelled round is history — it belongs on the bill's order-history panel so the
// guest can see it was voided, but it must never be charged for. Neither is a round the
// restaurant hasn't accepted yet ('placed'): it may still be rejected, and until it is
// accepted it isn't food anyone owes for. (It still holds the bill open — see
// pendingRoundsOf — so a table can't be settled around it.)
const isBilledOrder = (order) => order?.status !== 'cancelled' && order?.status !== 'placed';

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
    // A round still awaiting the restaurant's approval is pending too, but for a different
    // reason — say so, since the floor can't do anything about it and the owner can.
    const awaitingApproval = pending.filter((o) => o.status === 'placed').length;
    const message = awaitingApproval === pending.length
      ? `${awaitingApproval === 1 ? 'One round is' : `${awaitingApproval} rounds are`} still waiting for the restaurant to accept — accept or reject ${awaitingApproval === 1 ? 'it' : 'them'} before generating the bill.`
      : pending.length === 1
        ? 'One round has not been served yet — the bill can be generated once it reaches the table.'
        : `${pending.length} rounds have not been served yet — the bill can be generated once they reach the table.`;
    throw new ApiError(
      409,
      'ORDERS_PENDING',
      message,
      {
        awaitingApprovalCount: awaitingApproval,
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
 * Totals a dine-in bill with the one pricing engine (services/charges.service.js) — the same
 * rules a delivery order is priced by:
 *   - food GST at the platform's foodGstPercent, only for a GST-registered restaurant, on
 *     the food after any discount (it used to be the restaurant's own gstPercent on the
 *     pre-discount subtotal);
 *   - the restaurant's own service charge, on the pre-discount subtotal, exactly as before;
 *   - the platform fee, once per bill or once per billed round (Finance Settings →
 *     dineInPlatformFeeUnit), and none at all on a bill with nothing billed yet;
 *   - the payable total rounded to the rupee.
 * Returns the rupee fields the Bill model and every bill screen read, plus the paise
 * `charges` breakdown. `discountTotal` is passed in so this stays the one place the
 * arithmetic lives, for a fresh assemble and for a re-total after a discount.
 */
const dineInTotals = async ({ subtotal, restaurant, discountTotal = 0, billedOrderCount }) => {
  const settings = await getActiveSettings();
  const subtotalPaise = toPaise(round2(subtotal));
  const serviceChargePercent = restaurant?.settings?.serviceChargePercent ?? 0;
  const serviceChargePaise = percentOf(subtotalPaise, serviceChargePercent);
  let platformFeeCount = 0;
  if (billedOrderCount > 0) platformFeeCount = settings.dineInPlatformFeeUnit === 'order' ? billedOrderCount : 1;

  const charges = computeCustomerCharges({
    orderType: 'dine_in',
    foodSubtotalPaise: subtotalPaise,
    discountPaise: toPaise(round2(discountTotal)),
    restaurant,
    serviceChargePaise,
    platformFeeCount,
    settings,
  });

  return {
    subtotal: round2(subtotal),
    gstPercent: charges.food.gstPercent,
    gstAmount: toRupees(charges.food.gst),
    serviceChargePercent,
    serviceChargeAmount: toRupees(serviceChargePaise),
    platformFee: toRupees(charges.platformFee.total),
    discountTotal: toRupees(charges.food.discount),
    grandTotal: toRupees(charges.grandTotal),
    charges,
  };
};

// How long a bill is held at its total for a guest paying online before an abandoned payment is
// released. Re-opening Razorpay (POST …/bill/pay) restarts it.
export const PAYMENT_HOLD_MS = 30 * 60 * 1000;

const intentsOf = (bill) => [...new Set([...(bill.paymentIntentHistory ?? []), bill.paymentIntentId].filter(Boolean))];

// payment.service.js imports this module; loaded on use so the two never depend on each
// other's load order.
const livePaymentOn = async (bill) => {
  const { hasLivePayment } = await import('./payment.service.js');
  return hasLivePayment(intentsOf(bill), { expectedPaise: toPaise(bill.grandTotal) });
};

/**
 * Re-opens a table whose online payment was abandoned: held longer than PAYMENT_HOLD_MS and no
 * payment that could still settle it. Returns true when released. Never on a "couldn't tell"
 * (gateway error) — the hold stays and a later read tries again.
 */
const releaseIfAbandoned = async (bill, session) => {
  const startedAt = new Date(bill.paymentStartedAt ?? bill.updatedAt ?? 0).getTime();
  if (Date.now() - startedAt < PAYMENT_HOLD_MS) return false;
  try {
    if (await livePaymentOn(bill)) return false;
  } catch (err) {
    logger.warn({ err, billId: bill._id }, 'Could not check an abandoned bill payment — keeping the hold');
    return false;
  }
  const reopened = await TableSession.updateOne({ _id: session._id, status: 'bill_requested' }, { $set: { status: 'open' } });
  if (reopened.modifiedCount) logger.info({ billId: bill._id }, 'Abandoned bill payment released');
  return true;
};

/**
 * Staff (owner or waiter) releasing a bill held for a guest's online payment — the guest walked
 * away from Razorpay, or will pay at the counter. Refused (409 PAYMENT_IN_PROGRESS) while a
 * payment that can still settle it is authorized or captured. Re-opens the sitting and returns
 * the re-priced bill.
 */
export const releasePayment = async ({ billId, restaurantId }) => {
  const bill = await Bill.findOne({ _id: billId, restaurantId }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'open') throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has already been settled');
  if (await livePaymentOn(bill)) {
    throw new ApiError(409, 'PAYMENT_IN_PROGRESS', 'The guest\'s payment is going through — it will show as paid in a moment');
  }
  await TableSession.updateOne({ _id: bill.tableSessionId, status: 'bill_requested' }, { $set: { status: 'open' } });
  return assembleBill(bill.tableSessionId);
};

/**
 * Asked before a dine-in round is cancelled (kitchen.service.js): refused (409
 * PAYMENT_IN_PROGRESS) while the guest is paying the table's bill online — the bill is held at a
 * total that includes the round, so the guest would pay for food they won't get. Staff release
 * the payment first (releasePayment), which re-prices the bill without the round. Safe to call
 * for any order: anything that isn't a dine-in round on a bill being paid passes.
 */
export const assertRoundCancellable = async (order) => {
  if (order?.type !== 'dine_in' || !order.tableSessionId) return;
  const session = await TableSession.findById(order.tableSessionId).select('status').lean();
  if (session?.status !== 'bill_requested') return;
  const bill = await Bill.findOne({ tableSessionId: order.tableSessionId, status: 'open' }).select('paymentIntentId').lean();
  if (!bill?.paymentIntentId) return;
  throw new ApiError(
    409,
    'PAYMENT_IN_PROGRESS',
    'The guest is paying this table\'s bill online — release the payment before cancelling a round'
  );
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
  // The guest is paying it: the amount they were asked for is the bill. Re-pricing now (a
  // settings change, a GST toggle, a round voided) would settle and book a total they never
  // paid. Ordering is locked meanwhile (new rounds open a fresh session); if they back out the
  // session reopens and the next read re-prices. A payment abandoned without backing out (app
  // closed) is released once PAYMENT_HOLD_MS has passed with nothing paid — see releaseIfAbandoned.
  if (existing && session.status === 'bill_requested' && existing.paymentIntentId) {
    if (!(await releaseIfAbandoned(existing, session))) return existing;
  }

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
    ...(await dineInTotals({
      subtotal,
      restaurant,
      discountTotal,
      billedOrderCount: orders.filter(isBilledOrder).length,
    })),
  };

  let bill;
  if (existing) {
    // A re-priced total retires the amount the last Razorpay order was made for: a payment on
    // it is then checked against the new total (and refused if it differs) — never accepted at
    // the stale figure. Pay Now makes a fresh Razorpay order for the new amount.
    const update = { ...fields };
    if (existing.paymentAmountPaise != null && existing.paymentAmountPaise !== toPaise(fields.grandTotal)) {
      update.paymentAmountPaise = null;
    }
    // Only while still open: a payment or a counter settlement may have closed it since it was
    // read, and a settled bill must not be re-priced.
    bill = await Bill.findOneAndUpdate({ _id: existing._id, status: 'open' }, { $set: update }, { new: true });
    if (!bill) return Bill.findById(existing._id);
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
    // A delivery order is taxed by the platform's own food GST rate (Finance Settings),
    // already included in order.tax — the restaurant's dine-in gstPercent does not apply,
    // so the rate is reported as the one actually charged rather than the dine-in figure.
    gstPercent: order.charges?.food?.gstPercent ?? (subtotal > 0 ? round2((tax / subtotal) * 100) : 0),
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
    // The order's frozen pricing breakdown, so the receipt and the order can never disagree.
    charges: order.charges ?? null,
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
  if (bill.paymentIntentId && bill.tableSessionId) {
    const session = await TableSession.findById(bill.tableSessionId).select('status').lean();
    if (session?.status === 'bill_requested') {
      throw new ApiError(409, 'PAYMENT_IN_PROGRESS', 'The guest is paying this bill online — a discount can\'t be added now');
    }
  }

  // Personal offers are delivery-only and have no code; never applicable to a dine-in bill.
  const discount = await Discount.findOne({ code: discountCode, restaurantId, kind: { $ne: 'personal' } });
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

  const restaurant = await Restaurant.findById(bill.restaurantId).lean();
  const totals = await dineInTotals({
    subtotal: bill.subtotal,
    restaurant,
    discountTotal: bill.discountsApplied.reduce((s, d) => s + (d.amount ?? 0), 0),
    billedOrderCount: bill.batches.filter((b) => isBilledOrder(b)).length,
  });
  const update = { ...totals, discountsApplied: bill.discountsApplied };
  // Same as a re-assemble: a changed total retires the amount Razorpay was asked for.
  if (bill.paymentAmountPaise != null && bill.paymentAmountPaise !== toPaise(totals.grandTotal)) {
    update.paymentAmountPaise = null;
  }
  const updated = await Bill.findOneAndUpdate({ _id: bill._id, status: 'open' }, { $set: update }, { new: true });
  if (!updated) throw new ApiError(409, 'BILL_ALREADY_PAID', 'This bill has already been settled');
  return updated;
};

/**
 * Settles a dine-in bill — the one way a bill becomes paid (guest online, staff at the counter,
 * dev simulation). Atomic: only a bill that is still open is settled, so a guest's online
 * payment and a waiter's "cash" landing together settle it once; the loser gets 409
 * BILL_ALREADY_PAID (with `paidWith`, the Razorpay payment that settled it, if any).
 *
 * `payment` (online only) is the Razorpay payment being counted: { id, amountPaise, fee, tax,
 * via }. Its amount must equal the bill's total at the moment of settling — a bill re-priced
 * since the payment was checked answers 409 BILL_TOTAL_CHANGED and stays open. `via` alone
 * (no id) is a dev simulation.
 */
export const markPaid = async ({ billId, restaurantId, paymentMethod, payment = null }) => {
  const now = new Date();
  // Online = the guest paid Yulo through Razorpay; anything a staff member marks (cash, UPI,
  // card) was paid to the restaurant at the counter. Settlement treats the two very
  // differently, so it is recorded explicitly rather than inferred from paidBy later.
  const paymentChannel = paymentMethod === 'online' ? 'online' : 'counter';

  const filter = { _id: billId, restaurantId, status: 'open' };
  if (payment?.amountPaise != null) filter.grandTotal = toRupees(payment.amountPaise);
  const set = {
    status: 'paid',
    paidAt: now,
    paidBy: paymentMethod,
    paymentChannel,
    // The sitting ends when the bill is settled — recorded on the bill itself so the receipt
    // can state the period it covers without joining back to a session that may be reused.
    closedAt: now,
  };
  if (payment?.via) set.paymentConfirmedVia = payment.via;
  if (payment?.id) {
    Object.assign(set, {
      razorpayPaymentId: payment.id,
      razorpayFee: payment.fee ?? null,
      razorpayTax: payment.tax ?? null,
      paymentFailureReason: null,
    });
  }

  const bill = await Bill.findOneAndUpdate(filter, { $set: set }, { new: true });
  if (!bill) {
    const current = await Bill.findOne({ _id: billId, restaurantId }).select('status paymentChannel razorpayPaymentId grandTotal').lean();
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
    // A settled bill is never settled again — least of all re-marked "cash" after the guest paid
    // online, which would bill the table twice and turn Yulo's credit into a counter debit.
    if (current.status !== 'open') {
      throw new ApiError(
        409,
        'BILL_ALREADY_PAID',
        current.paymentChannel === 'online' ? 'This bill was already paid online by the guest' : 'This bill has already been settled',
        { paidWith: current.razorpayPaymentId ?? null, paymentChannel: current.paymentChannel ?? null }
      );
    }
    throw new ApiError(409, 'BILL_TOTAL_CHANGED', 'The bill changed while it was being paid', {
      grandTotal: current.grandTotal,
      paidPaise: payment?.amountPaise ?? null,
    });
  }

  const [session] = await Promise.all([
    TableSession.findByIdAndUpdate(
      bill.tableSessionId,
      { status: 'paid', closedAt: now },
      { new: false }
    ),
    Order.updateMany(
      { tableSessionId: bill.tableSessionId, paymentStatus: 'pending', status: { $ne: 'cancelled' } },
      { $set: { paymentStatus: 'paid', paymentMethod, paymentChannel } }
    ),
  ]);

  if (session?.tableId) {
    const table = await Table.findById(session.tableId).lean();
    if (table) notifyService.tableStatusChanged(restaurantId, table, 'paid');
  }

  // Online → the restaurant's earning; counter → the platform fee it owes Yulo.
  await onBillPaid(bill);

  // A round billed in this total but cancelled before the payment landed (while the bill was
  // held for the guest): the guest paid Yulo for food they didn't get — flagged for an admin to
  // refund, the same as a round cancelled after payment.
  if (paymentChannel === 'online') {
    const billedIds = (bill.batches ?? []).filter(isBilledOrder).map((b) => b.orderId).filter(Boolean);
    if (billedIds.length) {
      const voided = await Order.find({ _id: { $in: billedIds }, status: 'cancelled' }).lean();
      for (const round of voided) {
        await flagCancelledPaidDineInRound(round).catch((err) =>
          logger.error({ err, orderId: round._id }, 'Could not flag a round cancelled before its bill was paid')
        );
      }
    }
  }

  return bill;
};
