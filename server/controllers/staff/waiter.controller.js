import { z } from 'zod';
import Table from '../../models/Table.js';
import TableSession from '../../models/TableSession.js';
import Bill from '../../models/Bill.js';
import Order from '../../models/Order.js';
import * as waiterService from '../../services/waiter.service.js';
import * as kitchenService from '../../services/kitchen.service.js';
import * as orderViewService from '../../services/orderView.service.js';
import * as menuService from '../../services/menu.service.js';
import * as orderService from '../../services/order.service.js';
import * as billingService from '../../services/billing.service.js';
import * as billViewService from '../../services/billView.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const waiterOrderSchema = z.object({
  tableSessionId: z.string().min(1),
  items: z.array(z.object({
    menuItemId: z.string().min(1),
    quantity: z.number().int().min(1),
    note: z.string().optional(),
  })).min(1),
  specialInstructions: z.string().optional(),
});

export const scanTable = asyncHandler(async (req, res) => {
  const { qrToken } = req.body;
  if (!qrToken) throw new ApiError(400, 'VALIDATION_ERROR', 'qrToken is required');

  const data = await waiterService.scanTable({
    restaurantId: req.staff.restaurantId,
    qrToken,
    staffId: req.staff._id,
  });

  sendSuccess(res, 200, 'Table scanned', data);
});

export const getTables = asyncHandler(async (req, res) => {
  const [tables, sessions] = await Promise.all([
    Table.find({ restaurantId: req.staff.restaurantId, isActive: true }).lean(),
    TableSession.find({ restaurantId: req.staff.restaurantId, status: 'open' }).lean(),
  ]);

  const sessionMap = new Map(sessions.map((s) => [s.tableId.toString(), s]));
  const result = tables.map((t) => ({
    ...t,
    session: sessionMap.get(t._id.toString()) || null,
  }));

  sendSuccess(res, 200, 'Tables fetched', { tables: result });
});

export const getMenu = asyncHandler(async (req, res) => {
  const menu = await menuService.getMenu(req.staff.restaurantId);
  sendSuccess(res, 200, 'Menu', { menu });
});

export const createOrder = asyncHandler(async (req, res) => {
  const result = waiterOrderSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order data', result.error.flatten());
  }

  const idempotencyKey = req.headers['idempotency-key'] || null;

  const order = await orderService.createOrder({
    ...result.data,
    restaurantId: req.staff.restaurantId,
    staffId: req.staff._id,
    type: 'dine_in',
    idempotencyKey,
  });

  const statusCode = order.duplicate ? 200 : 201;
  sendSuccess(res, statusCode, order.duplicate ? 'Duplicate — existing order returned' : 'Order placed', { order });
});

// The floor asks two different questions of its sittings: "what is on my tables right
// now" and "what did I close today". They are different sets — a settled sitting is gone
// from the floor — so `scope` selects between them rather than the second quietly
// widening the first, which would put paid tables back into the live Active Orders list.
// Closed sittings are bounded to the current service day: the waiter's "Completed" tab is
// a shift record, not the restaurant's history (that lives in the owner portal).
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export const getSessions = asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'completed' ? 'completed' : 'open';

  const sessions = await TableSession.find(
    scope === 'completed'
      ? {
          restaurantId: req.staff.restaurantId,
          status: 'paid',
          closedAt: { $gte: startOfToday() },
        }
      : { restaurantId: req.staff.restaurantId, status: 'open' }
  )
    .populate('orders')
    .sort(scope === 'completed' ? { closedAt: -1 } : { openedAt: 1 })
    .lean();

  // Resolve the table identifier and each order's staff attribution once for the whole
  // page. The waiter's Active Orders screen shows a row per round, so it needs to name
  // who took each one — not just the session as a whole.
  const tableIds = [...new Set(sessions.map((s) => String(s.tableId)))];
  const tables = tableIds.length
    ? await Table.find({ _id: { $in: tableIds } }).select('identifier capacity').lean()
    : [];
  const tableById = new Map(tables.map((t) => [String(t._id), t]));

  const enrichedOrders = await orderViewService.enrichOrders(sessions.flatMap((s) => s.orders));
  const orderById = new Map(enrichedOrders.map((o) => [String(o._id), o]));

  // How a settled sitting was paid lives on its bill, not on the session, and it is the
  // one thing a closed table is worth showing beyond its total — so it is resolved only
  // for that scope.
  const billBySession = new Map();
  if (scope === 'completed' && sessions.length) {
    const bills = await Bill.find({ tableSessionId: { $in: sessions.map((s) => s._id) } })
      .select('tableSessionId grandTotal paidAt paidBy')
      .lean();
    bills.forEach((b) => billBySession.set(String(b.tableSessionId), b));
  }

  const result = sessions.map((s) => {
    const table = tableById.get(String(s.tableId)) ?? null;
    const orders = s.orders
      .map((o) => orderById.get(String(o._id)) ?? o)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((o, i) => ({ ...o, round: o.batchNumber ?? i + 1 }));

    const bill = billBySession.get(String(s._id)) ?? null;

    return {
      ...s,
      orders,
      tableNumber: table?.identifier ?? null,
      table: table ? { _id: table._id, identifier: table.identifier, capacity: table.capacity } : null,
      runningTotal: orders
        .filter((o) => o.status !== 'cancelled')
        .reduce((sum, o) => sum + (o.subtotal ?? 0), 0),
      payment: bill
        ? { total: bill.grandTotal, method: bill.paidBy ?? null, paidAt: bill.paidAt ?? s.closedAt }
        : null,
    };
  });

  sendSuccess(res, 200, scope === 'completed' ? 'Completed sittings' : 'Active sessions', {
    sessions: result,
  });
});

// A waiter marking a ticket served — the floor half of the order lifecycle, which until
// now had no endpoint at all: every transition ran through the chef KDS (role: chef), so
// nothing could record that food actually reached the table.
//
// Deliberately not limited to 'served' alone: plenty of restaurants run no KDS, and there
// the waiter is the only person moving the ticket. The shared transition table in
// kitchen.service.js still enforces the ordering, so a waiter can advance a ticket but
// never skip backwards or invent a state.
const waiterStatusSchema = z.object({
  newStatus: z.enum(['confirmed', 'preparing', 'ready', 'served']),
});

export const updateOrderStatus = asyncHandler(async (req, res) => {
  const result = waiterStatusSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid status', result.error.flatten());
  }

  const existing = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.staff.restaurantId,
  })
    .select('status type')
    .lean();
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  // 'served' means "carried to the table" — meaningless for delivery/takeaway, which
  // reach the customer via 'out_for_delivery' -> 'delivered' instead.
  if (result.data.newStatus === 'served' && existing.type !== 'dine_in') {
    throw new ApiError(400, 'INVALID_TRANSITION', "Only dine-in orders can be marked 'served'");
  }

  const order = await kitchenService.updateOrderStatus({
    orderId: req.params.orderId,
    currentStatus: existing.status,
    newStatus: result.data.newStatus,
    actor: { staffId: req.staff._id, staffName: req.staff.name, role: 'waiter' },
  });

  sendSuccess(res, 200, 'Order status updated', {
    order: await orderViewService.enrichOrder(order.toObject ? order.toObject() : order),
  });
});

export const getBill = asyncHandler(async (req, res) => {
  // Generating the bill is the last step of the sitting, not a mid-meal peek: a round the
  // kitchen still holds can be voided or re-fired, so a receipt raised now would be a
  // receipt for food nobody has. 409 ORDERS_PENDING until every round is served — the
  // same rule the floor's "Generate bill" button reads off the session's own statuses.
  await billingService.assertSessionFullyServed(req.params.sessionId);

  const bill = await billingService.assembleBill(req.params.sessionId);
  // Shaped by billView.service.js, the same shape the owner console, the guest's own bill
  // screen and the platform admin read — the floor and the guest must never be looking at
  // two different readings of one bill.
  sendSuccess(res, 200, 'Bill', { bill: await billViewService.buildBillView(bill) });
});

export const markPaid = asyncHandler(async (req, res) => {
  const { paymentMethod } = req.body;
  if (!paymentMethod) throw new ApiError(400, 'VALIDATION_ERROR', 'paymentMethod is required');

  // Resolve billId from the session
  const session = await TableSession.findById(req.params.sessionId).lean();
  if (!session || session.restaurantId.toString() !== req.staff.restaurantId.toString()) {
    throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  }

  // Settling is the other half of the same rule — a table cannot be closed out and freed
  // while the kitchen still owes it a round.
  await billingService.assertSessionFullyServed(req.params.sessionId);

  const bill = await Bill.findOne({ tableSessionId: req.params.sessionId, status: 'open' }).lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'No open bill for this session — call assemble first');

  const paid = await billingService.markPaid({
    billId: bill._id,
    restaurantId: req.staff.restaurantId,
    paymentMethod,
  });

  sendSuccess(res, 200, 'Bill marked as paid', { bill: await billViewService.buildBillView(paid) });
});
