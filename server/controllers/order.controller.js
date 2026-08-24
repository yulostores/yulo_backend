import crypto from 'crypto';
import { z } from 'zod';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import Review from '../models/Review.js';
import * as orderService from '../services/order.service.js';
import * as deliveryAssignmentService from '../services/deliveryAssignment.service.js';
import * as paymentService from '../services/payment.service.js';
import * as trackingService from '../services/tracking.service.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

// Review.orderId already has a unique index (models/Review.js) — a batch $in query
// against it is cheap even for a full page of orders, so this joins rather than
// denormalizing a rating field onto Order itself (which would need its own write-time
// upkeep, like the review model's own post('save') hook already does for
// Restaurant.avgRating, for a field that's read far less often than it'd be written).
const attachRatings = async (orders) => {
  const orderIds = orders.map((o) => o._id);
  const reviews = await Review.find({ orderId: { $in: orderIds } })
    .select('orderId rating comment createdAt')
    .lean();
  const reviewByOrderId = new Map(reviews.map((r) => [String(r.orderId), r]));

  for (const order of orders) {
    const review = reviewByOrderId.get(String(order._id));
    order.rating = review
      ? { value: review.rating, comment: review.comment, createdAt: review.createdAt }
      : null;
  }
  return orders;
};

const verifyPaymentSchema = z.object({
  razorpay_payment_id: z.string().min(1),
  razorpay_order_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

const orderItemSchema = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().min(1),
  note: z.string().optional(),
});

const createOrderSchema = z.object({
  restaurantId: z.string().min(1),
  items: z.array(orderItemSchema).min(1),
  type: z.enum(['delivery', 'takeaway']),
  deliveryAddress: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    coordinates: z.tuple([z.number(), z.number()]).optional(),
  }).optional(),
  paymentMethod: z.enum(['cash', 'online', 'card']).default('cash'),
  specialInstructions: z.string().optional(),
});

const checkoutSchema = z.object({
  addressId: z.string().optional(),
  deliveryInstructions: z.string().optional().default(''),
  cookingRequests: z.boolean().optional().default(false),
  extraCutlery: z.boolean().optional().default(false),
  tip: z.number().min(0).optional().default(0),
  vegFleetOptIn: z.boolean().optional().default(false),
  paymentMethod: z.enum(['cod', 'online']).default('cod'),
});

// Shared by createOrder and checkout below — same Razorpay-order-creation block, one
// place to change if/when a real webhook-verified flow replaces this placeholder.
//
// Persists the Razorpay order id onto Order.paymentIntentId — without this, neither
// POST /api/orders/:id/payment/verify nor the /api/webhooks/razorpay handler would have
// anything to confirm a submitted payment actually belongs to this order (this was
// created and returned to the client, but never actually saved anywhere, before this step).
const createRazorpayOrderIfNeeded = async (order) => {
  if (!env.RAZORPAY_KEY_ID) return { clientSecret: null };
  try {
    const Razorpay = (await import('razorpay')).default;
    const rzp = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
    const rzpOrder = await rzp.orders.create({
      amount: Math.round((order.grandTotal ?? order.subtotal) * 100),
      currency: 'INR',
      receipt: order._id.toString(),
    });
    order.paymentIntentId = rzpOrder.id;
    await order.save();
    return { clientSecret: rzpOrder.id };
  } catch (err) {
    // Previously swallowed entirely — a broken key, a network blip, or a Razorpay
    // outage looked identical to "no gateway configured" (env.RAZORPAY_KEY_ID unset),
    // with zero trace in the logs. Still returns clientSecret: null either way (the
    // order is placed either way; the customer just can't pay online this attempt),
    // but now the two cases are distinguishable after the fact.
    logger.error({ err, orderId: order._id }, 'Razorpay order creation failed');
    return { clientSecret: null };
  }
};

export const createOrder = asyncHandler(async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order data', result.error.flatten());
  }

  const { restaurantId, items, type, deliveryAddress, paymentMethod, specialInstructions } = result.data;
  const idempotencyKey = req.headers['idempotency-key'] || null;

  const order = await orderService.createOrder({
    restaurantId,
    userId: req.user._id,
    type,
    items,
    deliveryAddress,
    paymentMethod,
    specialInstructions,
    idempotencyKey,
  });

  if (order.duplicate) {
    return sendSuccess(res, 200, 'Duplicate — existing order returned', { order: { orderId: order.orderId } });
  }

  const responseData = { order };
  if (paymentMethod === 'online') {
    Object.assign(responseData, await createRazorpayOrderIfNeeded(order));
  }

  sendSuccess(res, 201, 'Order placed', responseData);
});

// The cart-based checkout flow (Prompt 9's cart -> a real Order). Kept as a separate
// route/handler from createOrder above rather than merged into it: the input contract is
// fundamentally different (reads the caller's server-side cart, never trusts a
// client-sent items array), and createOrder's existing raw-items shape stays available
// unchanged for any caller still using it.
export const checkout = asyncHandler(async (req, res) => {
  const result = checkoutSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid checkout data', result.error.flatten());
  }

  const {
    addressId,
    deliveryInstructions,
    cookingRequests,
    extraCutlery,
    tip,
    vegFleetOptIn,
    paymentMethod,
  } = result.data;
  const idempotencyKey = req.headers['idempotency-key'] || null;

  const order = await orderService.createOrderFromCart({
    userId: req.user._id,
    addressId,
    deliveryInstructions,
    cookingRequests,
    extraCutlery,
    tip,
    vegFleetOptIn,
    paymentMethod,
    idempotencyKey,
  });

  if (order.duplicate) {
    return sendSuccess(res, 200, 'Duplicate — existing order returned', { order: { orderId: order.orderId } });
  }

  const restaurant = await Restaurant.findById(order.restaurantId).select('name').lean();

  // Screen 22/22v need enough to render immediately, no extra round-trip — orderId/
  // restaurantName/status/vegFleetOptIn at the top level, plus the full order for anything else.
  const responseData = {
    orderId: order._id,
    restaurantName: restaurant?.name ?? null,
    status: order.status,
    vegFleetOptIn: order.vegFleetOptIn,
    order,
  };
  if (paymentMethod === 'online') {
    Object.assign(responseData, await createRazorpayOrderIfNeeded(order));
  }

  sendSuccess(res, 201, 'Order placed', responseData);
});

// Stand-in for the real Razorpay Checkout + verify round trip while no gateway SDK is
// bundled client-side (see Payment.jsx). Gated on the exact same signal
// createRazorpayOrderIfNeeded already uses for "no gateway wired in" — once
// RAZORPAY_KEY_ID is configured, this route stops working rather than silently
// bypassing a real payment.
export const simulatePayment = asyncHandler(async (req, res) => {
  if (env.RAZORPAY_KEY_ID) {
    throw new ApiError(400, 'NOT_SIMULATED', 'A real payment gateway is configured; simulation is unavailable');
  }

  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.paymentMethod !== 'online') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This order was not placed for online payment');
  }

  // Idempotent: a retry after a dropped response re-confirms the same simulated payment
  // rather than minting a second fake payment id.
  if (order.paymentStatus !== 'paid') {
    order.paymentStatus = 'paid';
    order.razorpayPaymentId = `sim_${crypto.randomBytes(12).toString('hex')}`;
    await order.save();
  }

  sendSuccess(res, 200, 'Payment simulated', { order });
});

export const verifyPayment = asyncHandler(async (req, res) => {
  const result = verifyPaymentSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment verification data', result.error.flatten());
  }

  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  await paymentService.verifyOrderPayment(order, result.data);

  sendSuccess(res, 200, 'Payment verified', { order });
});

export const getVegFleetStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  const remainingSeconds = order.vegFleetSearchDeadline
    ? Math.max(0, Math.round((order.vegFleetSearchDeadline.getTime() - Date.now()) / 1000))
    : null;

  sendSuccess(res, 200, 'Veg-fleet status', { status: order.vegFleetAssignmentStatus, remainingSeconds });
});

export const keepWaitingVegFleet = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.vegFleetAssignmentStatus !== 'searching') {
    throw new ApiError(
      400,
      'INVALID_STATE',
      `Cannot keep waiting from status '${order.vegFleetAssignmentStatus}'`
    );
  }

  await deliveryAssignmentService.keepWaitingForVegFleet(order);

  const remainingSeconds = Math.max(
    0,
    Math.round((order.vegFleetSearchDeadline.getTime() - Date.now()) / 1000)
  );
  sendSuccess(res, 200, 'Still searching for a veg-only partner', {
    status: order.vegFleetAssignmentStatus,
    remainingSeconds,
  });
});

export const fallbackVegFleet = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.vegFleetAssignmentStatus !== 'searching') {
    throw new ApiError(
      400,
      'INVALID_STATE',
      `Cannot fall back from status '${order.vegFleetAssignmentStatus}'`
    );
  }

  await deliveryAssignmentService.fallbackVegFleet(order);

  sendSuccess(res, 200, 'Searching for any available partner', {
    status: order.vegFleetAssignmentStatus,
  });
});

export const listOrders = asyncHandler(async (req, res) => {
  const { page = 1 } = req.query;
  const parsedPage = Math.max(1, parseInt(page, 10));
  const PAGE_SIZE = 20;

  const [orders, total] = await Promise.all([
    Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip((parsedPage - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .lean(),
    Order.countDocuments({ userId: req.user._id }),
  ]);
  // vegFleetOptIn/vegFleetAssignmentStatus/dedicatedBagRequired (Prompt 10) are already
  // plain top-level Order fields with no .select() narrowing them out — they're already
  // present on every order returned above. `rating` is the one field that genuinely
  // isn't there yet.
  await attachRatings(orders);

  sendSuccess(res, 200, 'Orders', { orders, total, page: parsedPage });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  await attachRatings([order]);

  // pickupOtp's only surface to the customer: no SMS/push channel exists anywhere in this
  // codebase (notify.service.js is Socket.IO-room-only), so this tracking-screen response is
  // where they read the code to hand to their delivery partner. Only shown while it's still
  // useful (assigned, not yet verified) — and the rest of deliveryAssignment's internal
  // offer-routing bookkeeping (offeredTo/offerStatus/offerExpiresAt/history — other partners'
  // rejection reasons, etc.) is deliberately NOT passed through here, unlike the fields that
  // were already exposed before this change.
  if (order.deliveryAssignment) {
    const { partnerId, status, assignedAt, pickupOtp, pickupOtpVerifiedAt } = order.deliveryAssignment;
    order.deliveryAssignment = {
      partnerId,
      status,
      assignedAt,
      pickupOtpVerifiedAt,
      pickupOtp: status === 'assigned' && !pickupOtpVerifiedAt ? pickupOtp : undefined,
    };
  }

  sendSuccess(res, 200, 'Order', { order });
});

export const getTracking = asyncHandler(async (req, res) => {
  const tracking = await trackingService.getOrderTracking(req.params.id, req.user._id);
  sendSuccess(res, 200, 'Order tracking', tracking);
});

export const reorder = asyncHandler(async (req, res) => {
  const { cart, bill, removedItems } = await orderService.reorderOrder(req.params.id, req.user._id);
  sendSuccess(res, 200, 'Items added to cart', { cart, bill, removedItems });
});
