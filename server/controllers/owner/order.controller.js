import Order from '../../models/Order.js';
import * as orderViewService from '../../services/orderView.service.js';
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
