import crypto from 'crypto';
import { z } from 'zod';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import Review from '../models/Review.js';
import * as orderService from '../services/order.service.js';
import * as deliveryAssignmentService from '../services/deliveryAssignment.service.js';
import * as paymentService from '../services/payment.service.js';
import * as trackingService from '../services/tracking.service.js';
import * as orderApprovalService from '../services/orderApproval.service.js';
import { customerRefundView } from '../services/refund.service.js';
import { withoutInternalMoney } from '../services/ledger.service.js';
import { toPaise } from '../utils/money.js';
import { isCodEnabled, paymentSimulationEnabled } from '../config/payments.config.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';
import * as activityService from '../services/activity.service.js';

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

// The list query is lean with no populate, so an order row carries only a bare
// restaurantId — nothing the Orders-tab card can show as a storefront name. One
// batched lookup keyed by the page's distinct restaurantIds attaches
// { name, logo } to every order (the same `.select('name logo')` the checkout
// handler already does per order, done once for the whole page here). A row whose
// restaurant was since deleted gets `restaurant: null` rather than an error.
const attachRestaurants = async (orders) => {
  const ids = [...new Set(orders.map((o) => String(o.restaurantId)).filter(Boolean))];
  if (ids.length === 0) return orders;

  const restaurants = await Restaurant.find({ _id: { $in: ids } })
    .select('name logo')
    .lean();
  const byId = new Map(restaurants.map((r) => [String(r._id), r]));

  for (const order of orders) {
    const restaurant = byId.get(String(order.restaurantId));
    order.restaurant = restaurant
      ? { name: restaurant.name, logo: restaurant.logo ?? null }
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
  // Same shape the checkout path snapshots (services/order.service.js's
  // createOrderFromCart) — this raw-items endpoint used to accept only street/city/
  // coordinates, so an order placed through it reached the restaurant without a PIN.
  // contactName/contactPhone are optional here too: order.service fills them from the
  // ordering account when they're absent, and never trusts a client-supplied phone as
  // the CUSTOMER's number (that stays the account's verified one) — this is only the
  // "who to ring at the door" field.
  deliveryAddress: z.object({
    label: z.string().max(40).optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    pincode: z.string().optional(),
    coordinates: z.tuple([z.number(), z.number()]).optional(),
    contactName: z.string().trim().min(1).max(60).optional(),
    contactPhone: z.string().trim().min(6).max(20).optional(),
  }).optional(),
  paymentMethod: z.enum(['cash', 'online', 'card']).default('cash'),
  specialInstructions: z.string().optional(),
});

const checkoutSchema = z.object({
  addressId: z.string().optional(),
  deliveryInstructions: z.string().optional().default(''),
  cookingRequests: z.boolean().optional().default(false),
  // Optional text for the cooking request; older app builds never send it.
  cookingInstructions: z.string().trim().max(300).optional().default(''),
  extraCutlery: z.boolean().optional().default(false),
  tip: z.number().min(0).optional().default(0),
  vegFleetOptIn: z.boolean().optional().default(false),
  paymentMethod: z.enum(['cod', 'online']).default('cod'),
  // Optional: the charges.grandTotal (paise) the checkout summary showed — 409 PRICE_CHANGED if
  // the order would now cost something else.
  expectedTotalPaise: z.number().int().min(0).optional(),
});

// Runs BEFORE an order is created, so a refused payment choice never leaves an order behind.
// Online needs a configured gateway (or dev simulation); anything else on a delivery is cash
// on delivery, which the business can switch off. Takeaway cash is paid at the counter on
// pickup and isn't COD.
const assertPaymentChoiceAllowed = async ({ paymentMethod, type }) => {
  if (paymentMethod === 'online') {
    paymentService.assertOnlinePaymentAvailable();
    return;
  }
  if (type === 'delivery' && !(await isCodEnabled())) {
    throw new ApiError(400, 'COD_UNAVAILABLE', 'Cash on delivery is not available right now — please pay online');
  }
};

// Shared by createOrder and checkout below. Creates the Razorpay order for an order that
// has just been placed for online payment and stamps its id (paymentIntentId) and the exact
// paise amount (paymentAmountPaise) onto the order — verify and the webhook check a
// payment against both.
//
// Outcomes the client can tell apart:
//   razorpayOrder set           → open Razorpay Checkout with it
//   paymentSimulated: true      → dev simulation is on; use POST .../payment/simulate
//   paymentError set            → the gateway failed just now; the order exists but is unpaid
//                                 (it can't be accepted by the restaurant until paid)
const createRazorpayOrderIfNeeded = async (order) => {
  try {
    // keyId is Razorpay's publishable key, safe to hand to the client.
    const razorpayOrder = await paymentService.createRazorpayOrder({
      amountRupees: order.grandTotal ?? order.subtotal,
      receipt: order._id,
      notes: { orderId: String(order._id) },
    });
    if (!razorpayOrder) return { clientSecret: null, razorpayOrder: null, paymentSimulated: true };

    paymentService.adoptRazorpayOrder(order, razorpayOrder);
    await order.save();
    return { clientSecret: razorpayOrder.id, razorpayOrder };
  } catch (err) {
    // The order is already placed by the time this runs, so this reports rather than throws.
    logger.error({ err, orderId: order._id }, 'Razorpay order creation failed');
    return {
      clientSecret: null,
      razorpayOrder: null,
      paymentError: err instanceof ApiError ? err.code : 'PAYMENT_GATEWAY_ERROR',
    };
  }
};

export const createOrder = asyncHandler(async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid order data', result.error.flatten());
  }

  const { restaurantId, items, type, deliveryAddress, paymentMethod, specialInstructions } = result.data;
  const idempotencyKey = req.headers['idempotency-key'] || null;

  await assertPaymentChoiceAllowed({ paymentMethod, type });

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

  // The Razorpay order first — it records the payment intent on the order — then the response.
  // The fresh document carries the internal money keys (empty at this point) — not for the app.
  const payment = paymentMethod === 'online' ? await createRazorpayOrderIfNeeded(order) : {};
  const responseData = { order: withoutInternalMoney(order), ...payment };

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
    cookingInstructions,
    extraCutlery,
    tip,
    vegFleetOptIn,
    paymentMethod,
    expectedTotalPaise,
  } = result.data;
  const idempotencyKey = req.headers['idempotency-key'] || null;

  await assertPaymentChoiceAllowed({ paymentMethod, type: 'delivery' });

  const order = await orderService.createOrderFromCart({
    userId: req.user._id,
    addressId,
    deliveryInstructions,
    cookingRequests,
    cookingInstructions,
    extraCutlery,
    tip,
    vegFleetOptIn,
    paymentMethod,
    expectedTotalPaise,
    idempotencyKey,
  });

  if (order.duplicate) {
    return sendSuccess(res, 200, 'Duplicate — existing order returned', { order: { orderId: order.orderId } });
  }

  const restaurant = await Restaurant.findById(order.restaurantId).select('name').lean();
  // The Razorpay order first — it records the payment intent on the order — then the response.
  const payment = paymentMethod === 'online' ? await createRazorpayOrderIfNeeded(order) : {};

  // Screen 22/22v need enough to render immediately, no extra round-trip — orderId/
  // restaurantName/status/vegFleetOptIn at the top level, plus the full order for anything else.
  const responseData = {
    orderId: order._id,
    restaurantName: restaurant?.name ?? null,
    status: order.status,
    vegFleetOptIn: order.vegFleetOptIn,
    order: withoutInternalMoney(order),
    ...payment,
  };

  sendSuccess(res, 201, 'Order placed', responseData);
  // Not on the Idempotency-Key replay above — that returned before this line.
  void activityService.record(req, order.restaurantId, 'order_placed', {
    orderId: order._id,
    totalPaise: order.charges?.grandTotal,
    ...(order.$locals?.personalOfferId ? { offerId: order.$locals.personalOfferId } : {}),
  });
});

// The order as the customer may see it after a payment call: re-read from the database (so
// nothing a service set in memory — Razorpay's fee, settlement figures — rides along; those are
// select:false) with the refund in plain words.
// The delivery as the customer may see it: who is assigned and when the pickup happened.
// Never the pickup OTP — the restaurant reads that to the rider at handover (owner and kitchen
// order views, services/orderView.service.js) — nor the offer bookkeeping (offeredTo /
// offerStatus / offerExpiresAt / history: other riders' rejections) or the rider's pay.
// The delivery code IS the customer's: while the rider has the food (picked_up) it is shown so
// they can read it out at the door — only on reads that selected it (getOrder; the tracking
// service has its own copy). Gone once the order is delivered.
const withCustomerDelivery = (order) => {
  if (order?.deliveryAssignment) {
    const { partnerId, status, assignedAt, pickupOtpVerifiedAt, deliveryOtp } = order.deliveryAssignment;
    order.deliveryAssignment = {
      partnerId,
      status,
      assignedAt,
      pickupOtpVerifiedAt,
      deliveryOtp: status === 'picked_up' ? deliveryOtp ?? null : null,
    };
  }
  return order;
};

const customerOrderView = async (orderId) => {
  const order = await Order.findById(orderId).lean();
  if (order) order.refund = customerRefundView(order);
  return withCustomerDelivery(order);
};

// Dev/local stand-in for the Razorpay Checkout + verify round trip. Only exists when
// payment simulation is on (config/payments.config.js) — never in production, whatever the
// flag says. Otherwise it answers exactly like an unknown route, so nothing can probe it.
export const simulatePayment = asyncHandler(async (req, res) => {
  if (!paymentSimulationEnabled) {
    throw new ApiError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`);
  }

  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.paymentMethod !== 'online') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This order was not placed for online payment');
  }

  // No money moves in a simulation, so there's nothing to refund: just refuse to "pay"
  // for an order the restaurant rejected (or that timed out) instead of flagging one.
  if (order.status === 'cancelled' && order.paymentStatus !== 'paid') {
    throw new ApiError(409, 'ORDER_CANCELLED', 'This order was cancelled — there is nothing to pay');
  }

  // Idempotent: a retry after a dropped response re-confirms the same simulated payment
  // rather than minting a second fake payment id.
  if (order.paymentStatus !== 'paid') {
    await paymentService.recordCapturedPayment(order, `sim_${crypto.randomBytes(12).toString('hex')}`, null, 'simulation');
  }

  sendSuccess(res, 200, 'Payment simulated', { order: await customerOrderView(order._id) });
});

// Paise the order's payment is for — frozen when its first Razorpay order was created, else
// its grand total.
const orderAmountPaise = (order) => order.paymentAmountPaise ?? toPaise(order.grandTotal ?? order.subtotal);

const canRetryPayment = (order) =>
  order.paymentMethod === 'online' &&
  !['paid', 'refunded'].includes(order.paymentStatus) &&
  order.status !== 'cancelled';

// POST /api/orders/:id/payment/retry — pay for an online order whose payment didn't go
// through (dismissed, failed, app killed). Returns the Razorpay order to open Checkout with,
// for the SAME frozen amount: the existing one when Razorpay still accepts payments on it,
// else a new one. 409 PAYMENT_ALREADY_RECEIVED when a payment already went through and is
// settling — poll GET .../payment instead. Same response shape as checkout.
export const retryPayment = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.paymentMethod !== 'online') {
    throw new ApiError(400, 'NOT_ONLINE_PAYMENT', 'This order is not paid online');
  }
  if (order.paymentStatus === 'paid') throw new ApiError(409, 'ALREADY_PAID', 'This order is already paid');
  if (!canRetryPayment(order)) {
    throw new ApiError(409, 'ORDER_CANCELLED', 'This order was cancelled — there is nothing to pay');
  }

  const result = await paymentService.ensureRazorpayOrder(order, {
    amountPaise: orderAmountPaise(order),
    receipt: order._id,
    notes: { orderId: String(order._id) },
  });
  if (!result) {
    return sendSuccess(res, 200, 'Use simulated payment', {
      orderId: order._id,
      clientSecret: null,
      razorpayOrder: null,
      paymentSimulated: true,
    });
  }

  // Conditional: a payment may have landed (webhook) while Razorpay was being asked — a paid
  // order must never be put back to 'pending'.
  const intent = result.razorpayOrder;
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $nin: ['paid', 'refunded'] }, status: { $ne: 'cancelled' } },
    {
      $set: {
        paymentStatus: 'pending',
        paymentFailureReason: null,
        ...(result.reused ? {} : { paymentIntentId: intent.id, paymentAmountPaise: intent.amount }),
      },
      ...(result.reused ? {} : { $addToSet: { paymentIntentHistory: intent.id } }),
    },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'ALREADY_PAID', 'This order was just paid or cancelled — refresh to see it');

  sendSuccess(res, 200, result.reused ? 'Payment ready' : 'New payment created', {
    orderId: order._id,
    clientSecret: result.razorpayOrder.id,
    razorpayOrder: result.razorpayOrder,
    reused: result.reused,
  });
});

// GET /api/orders/:id/payment — where the payment stands. An app whose verify call failed or
// never returned polls this instead of assuming the worst: a webhook may already have settled
// the payment (confirmedVia: 'webhook').
export const getPaymentStatus = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  sendSuccess(res, 200, 'Payment status', {
    orderId: order._id,
    paymentMethod: order.paymentMethod ?? null,
    paymentStatus: order.paymentStatus,
    paid: order.paymentStatus === 'paid',
    confirmedVia: order.paymentConfirmedVia ?? null,
    failureReason: order.paymentFailureReason ?? null,
    amount: orderAmountPaise(order) / 100,
    canRetry: canRetryPayment(order),
    refund: customerRefundView(order),
  });
});

export const verifyPayment = asyncHandler(async (req, res) => {
  const result = verifyPaymentSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payment verification data', result.error.flatten());
  }

  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  await paymentService.verifyOrderPayment(order, result.data);

  sendSuccess(res, 200, 'Payment verified', { order: await customerOrderView(order._id) });
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
  // The rider search — and with it the countdown this extends — only starts once the
  // restaurant accepts the order; a rejected one never searches at all.
  if (order.status === 'placed' || order.status === 'cancelled') {
    throw new ApiError(
      409,
      order.status === 'placed' ? 'ORDER_AWAITING_APPROVAL' : 'INVALID_STATE',
      order.status === 'placed'
        ? 'The restaurant has not accepted this order yet'
        : 'This order has been cancelled'
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
  // Allowed while the restaurant is still deciding (it is just the customer relaxing their
  // preference ahead of time — autoAssign won't search until acceptance), but not once the
  // order is cancelled.
  if (order.status === 'cancelled') {
    throw new ApiError(409, 'INVALID_STATE', 'This order has been cancelled');
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
  // present on every order returned above. `rating` and `restaurant` are the two the row
  // still has to be joined in — both mutate `orders` in place and touch different fields,
  // so they run together.
  await Promise.all([attachRatings(orders), attachRestaurants(orders)]);
  for (const order of orders) {
    order.refund = customerRefundView(order);
    withCustomerDelivery(order);
  }

  sendSuccess(res, 200, 'Orders', { orders, total, page: parsedPage });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id })
    .select('+deliveryAssignment.deliveryOtp')
    .lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  await attachRatings([order]);
  // { status, amount, timeline } in plain words, or null — never the internal refund record.
  order.refund = customerRefundView(order);

  withCustomerDelivery(order);

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

const cancelSchema = z.object({ confirmNoRefund: z.boolean().optional().default(false) }).default({});

// POST /api/orders/:id/cancel — body { confirmNoRefund?: boolean }.
// Before the kitchen starts: cancelled, and an online payment is refunded in full.
// Once it has started ('preparing'/'ready'): 400 CONFIRMATION_REQUIRED unless
// confirmNoRefund is true — then cancelled with no refund (the restaurant is paid).
// Once the food is on its way: 409 ORDER_NOT_CANCELLABLE. See services/refund.service.js.
export const cancelOrder = asyncHandler(async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cancel request', parsed.error.flatten());
  }
  const cancelled = await orderApprovalService.cancelByCustomer({
    userId: req.user._id,
    orderId: req.params.id,
    confirmNoRefund: parsed.data.confirmNoRefund,
  });
  const order = (await Order.findById(cancelled._id).lean()) ?? cancelled.toObject?.() ?? cancelled;
  order.refund = customerRefundView(order);
  sendSuccess(res, 200, 'Order cancelled', { order: withCustomerDelivery(order) });
});
