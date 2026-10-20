// Shared fixtures for payment tests: a fake Razorpay client, seed data, and the two
// signature schemes. Import AFTER the test has set any process.env it needs and BEFORE it
// starts the server (startTestServer imports app.js, which parses env once).

import crypto from 'node:crypto';

// Throwaway values that exist only in tests — never real keys.
export const TEST_KEY_ID = 'rzp_test_fake_key_id';
export const TEST_KEY_SECRET = 'test-only-razorpay-key-secret';
export const TEST_WEBHOOK_SECRET = 'test-only-razorpay-webhook-secret';

export const useFakeGatewayEnv = () => {
  process.env.RAZORPAY_KEY_ID = TEST_KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = TEST_KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
};

/**
 * Stand-in for the subset of the Razorpay SDK the backend uses. Records every call so tests
 * can assert on arguments; `addPayment` seeds what payments.fetch will return.
 */
export const createFakeRazorpay = () => {
  const store = new Map();
  const rzpOrders = new Map();
  const calls = { ordersCreate: [], ordersFetch: [], fetchPayments: [], fetch: [], capture: [], refund: [] };
  let orderSeq = 0;
  let refundSeq = 0;
  let nextFetchError = null;
  let nextRefundError = null;
  let refundStatus = 'pending'; // what payments.refund reports — Razorpay normal refunds start 'pending'

  return {
    calls,
    addPayment(payment) {
      const full = { currency: 'INR', status: 'captured', fee: 0, tax: 0, ...payment };
      store.set(full.id, full);
      return full;
    },
    failNextFetch(err) {
      nextFetchError = err;
    },
    failNextRefund(err) {
      nextRefundError = err;
    },
    refundsReturn(status) {
      refundStatus = status;
    },
    setOrderStatus(id, status) {
      rzpOrders.get(id).status = status;
    },
    orders: {
      async create(args) {
        calls.ordersCreate.push(args);
        orderSeq += 1;
        const order = { id: `order_fake_${orderSeq}`, amount: args.amount, currency: args.currency, receipt: args.receipt, status: 'created' };
        rzpOrders.set(order.id, order);
        return { ...order };
      },
      async fetch(id) {
        calls.ordersFetch.push(id);
        const order = rzpOrders.get(id);
        if (!order) throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
        return { ...order };
      },
      async fetchPayments(id) {
        calls.fetchPayments.push(id);
        return { items: [...store.values()].filter((p) => p.order_id === id).map((p) => ({ ...p })) };
      },
    },
    payments: {
      async fetch(id) {
        calls.fetch.push(id);
        if (nextFetchError) {
          const err = nextFetchError;
          nextFetchError = null;
          throw err;
        }
        const payment = store.get(id);
        if (!payment) {
          throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
        }
        return { ...payment };
      },
      async refund(paymentId, opts) {
        calls.refund.push({ paymentId, ...opts });
        if (nextRefundError) {
          const err = nextRefundError;
          nextRefundError = null;
          throw err;
        }
        refundSeq += 1;
        return { id: `rfnd_fake_${refundSeq}`, payment_id: paymentId, amount: opts.amount, status: refundStatus };
      },
      async capture(id, amount, currency) {
        calls.capture.push({ id, amount, currency });
        const payment = store.get(id);
        payment.status = 'captured';
        // Razorpay computes the fee at capture; any plausible figure will do here.
        payment.fee = payment.fee || Math.round(amount * 0.0236);
        payment.tax = payment.tax || Math.round(payment.fee * 0.18 / 1.18);
        return { ...payment };
      },
    },
  };
};

export const checkoutSignature = (razorpayOrderId, paymentId) =>
  crypto.createHmac('sha256', TEST_KEY_SECRET).update(`${razorpayOrderId}|${paymentId}`).digest('hex');

export const webhookSignature = (rawBody) =>
  crypto.createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');

export const paymentCapturedEvent = (payment, type = 'payment.captured') => ({
  entity: 'event',
  event: type,
  payload: { payment: { entity: payment } },
  created_at: Math.floor(Date.now() / 1000),
});

/** A customer, an approved GST-registered restaurant (no free-delivery threshold) and one dish. */
export const seedBasics = async () => {
  const { default: User } = await import('../models/User.js');
  const { default: Restaurant } = await import('../models/Restaurant.js');
  const { default: MenuItem } = await import('../models/MenuItem.js');
  const { default: Category } = await import('../models/Category.js');
  const { generateTokens } = await import('../services/auth.service.js');

  const owner = await User.create({ name: 'Owner', email: 'owner@test.local', role: 'restaurant_owner' });
  const customer = await User.create({ name: 'Asha', phone: '9876543210', role: 'customer' });
  const restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Test Kitchen',
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    isActive: true,
    approvalStatus: 'active',
    gstRegistered: true,
    delivery: { radiusKm: 10 },
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  const dish = await MenuItem.create({
    restaurantId: restaurant._id,
    categoryId: category._id,
    name: 'Thali',
    foodType: 'veg',
    sellingPrice: 300,
  });

  return {
    owner,
    customer,
    restaurant,
    dish,
    customerToken: generateTokens(customer._id, 'customer').accessToken,
  };
};

/** An online delivery order already waiting on a Razorpay order, as checkout leaves it. */
// ~1.1 km east of the seeded restaurant — inside its 10 km zone.
export const NEARBY_DROP = [77.6, 12.97];

export const createPendingOnlineOrder = async ({ restaurant, customer, dish }, overrides = {}) => {
  const { default: Order } = await import('../models/Order.js');
  return Order.create({
    restaurantId: restaurant._id,
    userId: customer._id,
    type: 'delivery',
    items: [{ menuItemId: dish._id, name: dish.name, price: 300, quantity: 1 }],
    subtotal: 300,
    grandTotal: 357,
    paymentMethod: 'online',
    paymentStatus: 'pending',
    paymentChannel: 'online',
    paymentIntentId: `order_rzp_${Math.random().toString(36).slice(2, 10)}`,
    paymentAmountPaise: 35700,
    statusHistory: [{ status: 'placed', byRole: 'customer' }],
    ...overrides,
  });
};
