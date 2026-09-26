import { z } from 'zod';
import Order from '../../models/Order.js';
import * as orderViewService from '../../services/orderView.service.js';
import * as orderApprovalService from '../../services/orderApproval.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const listOrders = asyncHandler(async (req, res) => {
  const { status, type, tableId, page = 1, limit = 20 } = req.query;
  const filter = { restaurantId: req.restaurant._id };
  if (status) filter.status = status;
  if (type) filter.type = type;
  // Lets the owner drill into one table from the grouped view without re-fetching all of it.
  if (tableId) filter.tableId = tableId;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Order.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Orders', {
    // Enriched, not raw: a bare Order can't name its table or the waiter who took it —
    // see services/orderView.service.js.
    orders: await orderViewService.enrichOrders(orders),
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

// Dine-in orders grouped table -> sitting -> rounds. The flat list above is still the
// right shape for delivery and for auditing a whole day; this is the shape the floor
// works in, where the table is the unit and the orders under it are its rounds.
export const listOrdersByTable = asyncHandler(async (req, res) => {
  const { scope = 'active', search = '' } = req.query;
  if (!['active', 'today', 'all'].includes(scope)) {
    throw new ApiError(400, 'VALIDATION_ERROR', "scope must be 'active', 'today' or 'all'");
  }

  const tables = await orderViewService.getOrdersByTable({
    restaurantId: req.restaurant._id,
    scope,
    search,
  });

  sendSuccess(res, 200, 'Orders by table', { tables, scope });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.orderId,
    restaurantId: req.restaurant._id,
  }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  sendSuccess(res, 200, 'Order', { order: await orderViewService.enrichOrder(order) });
});

// GET /api/owner/:restaurantId/orders/pending — every order still waiting for the
// restaurant's accept/reject, oldest first (the one that has waited longest is the one to
// answer first). Not paginated: this is a live inbox, and a restaurant with more than a
// screenful of unanswered orders has a bigger problem than pagination.
//
// `awaitingPayment` flags an online order the customer hasn't paid for yet — it is listed
// so the owner can see it coming, but accepting it answers 409 PAYMENT_PENDING.
export const listPendingOrders = asyncHandler(async (req, res) => {
  const filter = { restaurantId: req.restaurant._id, status: 'placed' };
  const [orders, count] = await Promise.all([
    Order.find(filter).sort({ createdAt: 1 }).limit(200).lean(),
    // The real total, not the page size — a badge reading "200" when 350 are waiting would
    // understate exactly the situation it exists to flag.
    Order.countDocuments(filter),
  ]);

  const enriched = await orderViewService.enrichOrders(orders);
  sendSuccess(res, 200, 'Pending orders', {
    orders: enriched.map((o) => ({
      ...o,
      awaitingPayment: o.paymentMethod === 'online' && o.paymentStatus !== 'paid',
    })),
    count,
    rejectionReasons: orderApprovalService.REJECTION_REASONS,
  });
});

// PATCH /api/owner/:restaurantId/orders/:orderId/accept
export const acceptOrder = asyncHandler(async (req, res) => {
  const order = await orderApprovalService.acceptOrder({
    restaurantId: req.restaurant._id,
    orderId: req.params.orderId,
    user: req.user,
  });
  sendSuccess(res, 200, 'Order accepted', {
    order: await orderViewService.enrichOrder(order.toObject()),
  });
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'Give the customer a reason').max(200),
});

// PATCH /api/owner/:restaurantId/orders/:orderId/reject { reason }
export const rejectOrder = asyncHandler(async (req, res) => {
  const result = rejectSchema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A rejection reason is required', result.error.flatten());
  }

  const order = await orderApprovalService.rejectOrder({
    restaurantId: req.restaurant._id,
    orderId: req.params.orderId,
    user: req.user,
    reason: result.data.reason,
  });
  sendSuccess(res, 200, 'Order rejected', {
    order: await orderViewService.enrichOrder(order.toObject()),
  });
});
