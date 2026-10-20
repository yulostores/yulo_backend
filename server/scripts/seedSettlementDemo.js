// A demo restaurant with one full settlement week — every case from the client's Payment Flow
// PDF, plus a refund and a cancel-after-preparation — so the restaurant portal's and super
// admin's settlement screens (F5, F6) and the integration walkthroughs (I1–I3) have real data.
//
//   node scripts/seedSettlementDemo.js              # seed last week's demo data
//   node scripts/seedSettlementDemo.js --generate   # …and generate that week's settlement
//
// LOCAL / STAGING ONLY — refuses to run when NODE_ENV=production, and against any database that
// isn't on this machine unless you pass --allow-remote (a staging DB you mean to seed). Re-runnable:
// it deletes its own previous demo data (everything belonging to the demo owner
// demo-owner@yulo.local) first. --generate settles the demo restaurant only.
//
// Logins it prints: the demo owner (email + password) for the restaurant portal.
//
// Orders are priced exactly as in the PDF (₹300 food, 5 % GST, ₹30 delivery, ₹12 platform fee),
// so their frozen breakdowns use a per-km rate that turns 1 km into the PDF's ₹25.42 + GST; the
// live Finance Settings are not changed.
//
// What lands in the week (restaurant net in brackets):
//   Case 1  delivery, customer paid delivery            ₹357 online  (+₹302.50)
//   Case 2  delivery, free delivery (restaurant pays ₹30) ₹327 online  (+₹273.55)
//   Case 3  dine-in bill paid online                      ₹327         (+₹303.55)
//   Case 4  dine-in bill paid in cash at the counter      ₹327         (−₹12.42)
//   Refund  delivery rejected by the restaurant after payment (−₹11.38 Razorpay fee)
//   Cancel  customer cancelled after preparation started, no refund   (+₹302.50)

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Category from '../models/Category.js';
import MenuItem from '../models/MenuItem.js';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import { getActiveSettings } from '../services/financeSettings.service.js';
import { computeCustomerCharges } from '../services/charges.service.js';
import { recordOrderEarning, recordBillSettlement, recordRefundGatewayFee } from '../services/ledger.service.js';
import { generateWeeklySettlements, previousWeekStart } from '../services/settlement.service.js';
import { hashPassword } from '../services/auth.service.js';
import { encryptField } from '../utils/fieldEncryption.js';

const DEMO_EMAIL = 'demo-owner@yulo.local';
const DEMO_PASSWORD = 'DemoOwner@123';
const HOUR = 60 * 60 * 1000;

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: seedSettlementDemo.js writes demo data and must never touch production.');
  process.exit(1);
}

// Every host in the connection string is this machine. mongodb+srv:// is always a remote cluster.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLocalUri = (uri) => {
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(String(uri ?? ''));
  if (!m) return false;
  return m[1].split(',').every((hostPort) => LOCAL_HOSTS.has(hostPort.replace(/:\d+$/, '').toLowerCase()));
};
if (!isLocalUri(process.env.MONGODB_URI) && !process.argv.includes('--allow-remote')) {
  console.error(
    'Refusing to run: MONGODB_URI is not a database on this machine. Pass --allow-remote only if it is a staging database you mean to fill with demo data.'
  );
  process.exit(1);
}

const wipePreviousDemo = async () => {
  const owner = await User.findOne({ email: DEMO_EMAIL }).lean();
  if (!owner) return;
  const restaurants = await Restaurant.find({ ownerId: owner._id }).select('_id').lean();
  const ids = restaurants.map((r) => r._id);
  await Promise.all([
    Order.deleteMany({ restaurantId: { $in: ids } }),
    Bill.deleteMany({ restaurantId: { $in: ids } }),
    Table.deleteMany({ restaurantId: { $in: ids } }),
    TableSession.deleteMany({ restaurantId: { $in: ids } }),
    MenuItem.deleteMany({ restaurantId: { $in: ids } }),
    Category.deleteMany({ restaurantId: { $in: ids } }),
    RestaurantLedgerEntry.deleteMany({ restaurantId: { $in: ids } }),
    RestaurantSettlement.deleteMany({ restaurantId: { $in: ids } }),
  ]);
  await Restaurant.deleteMany({ _id: { $in: ids } });
  await User.deleteOne({ _id: owner._id });
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await wipePreviousDemo();

  const settings = await getActiveSettings();
  // The PDF's pricing for the frozen breakdowns (see the header) — live settings untouched.
  const pdfPricing = { ...settings, deliveryPerKmRate: 2542, deliveryMinCharge: 0, deliveryDistanceRounding: 0.1 };

  const owner = await User.create({
    name: 'Demo Owner',
    email: DEMO_EMAIL,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    role: 'restaurant_owner',
  });

  let payoutAccount = { status: 'not_added' };
  if (process.env.DATA_ENCRYPTION_KEY) {
    payoutAccount = {
      accountHolderName: 'Demo Kitchen Foods',
      accountNumberEncrypted: encryptField('123456789012'),
      accountNumberLast4: '9012',
      ifsc: 'HDFC0001234',
      bankName: 'HDFC Bank',
      branch: 'Demo Branch',
      accountType: 'current',
      status: 'verified',
      submittedAt: new Date(),
      verifiedAt: new Date(),
    };
  } else {
    console.warn('DATA_ENCRYPTION_KEY not set — the demo bank account is left "not added" (its settlement will be on hold).');
  }

  const restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: 'Demo Kitchen',
    email: 'hello@demokitchen.local',
    phone: '9876500000',
    address: { street: '1 Demo Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
    location: { type: 'Point', coordinates: [77.59, 12.97] },
    isActive: true,
    approvalStatus: 'active',
    gstRegistered: true,
    delivery: { radiusKm: 10 },
    settings: { legalEntityType: 'Partnership', ownerName: 'Demo Owner', panNumber: 'ABCDE1234F', gstNumber: '29AAPFU0939F1ZV', serviceChargePercent: 0 },
    payoutAccount,
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Thalis' });
  const thali = await MenuItem.create({
    restaurantId: restaurant._id,
    categoryId: category._id,
    name: 'Demo Thali',
    foodType: 'veg',
    sellingPrice: 300,
  });

  // Mid-week last week, in the settlement time zone. Online payments are placed Monday–Wednesday:
  // they only count once Razorpay's T+2 working days have passed (B12), so a Thursday–Sunday
  // payment would clear into this week's statement instead of the demo week's.
  const weekStart = previousWeekStart(new Date(), settings.settlementCycle);
  const at = (dayOffset, hour) => new Date(weekStart.getTime() + dayOffset * 24 * HOUR + hour * HOUR);
  const item = [{ menuItemId: thali._id, name: thali.name, price: 300, quantity: 1 }];

  const deliveryOrder = async ({ free = false, when, fields = {} }) => {
    const charges = computeCustomerCharges({
      orderType: 'delivery',
      foodSubtotalPaise: 30000,
      restaurant: { gstRegistered: true, delivery: free ? { freeThreshold: 100 } : {} },
      distanceKm: 1,
      settings: pdfPricing,
    });
    return Order.create({
      restaurantId: restaurant._id,
      type: 'delivery',
      placedBy: 'customer',
      customerName: 'Demo Customer',
      items: item,
      subtotal: 300,
      charges,
      grandTotal: charges.grandTotal / 100,
      deliveryFee: charges.delivery.customerPays / 100,
      platformFee: 12,
      tax: 15,
      paymentMethod: 'online',
      paymentChannel: 'online',
      paymentStatus: 'paid',
      paymentConfirmedVia: 'webhook',
      razorpayPaymentId: `pay_demo_${Math.random().toString(36).slice(2, 10)}`,
      paymentAmountPaise: charges.grandTotal,
      // ≈ 2.7 % + 18 % GST, the PDF's Razorpay example.
      razorpayFee: Math.round(charges.grandTotal * 0.03186),
      razorpayTax: Math.round(charges.grandTotal * 0.03186 * (18 / 118)),
      status: 'delivered',
      deliveredAt: when,
      createdAt: new Date(when.getTime() - HOUR),
      deliveryAddress: { street: '22 Demo Road', city: 'Bengaluru', coordinates: [77.6, 12.97] },
      ...fields,
    });
  };

  // Case 1 & 2
  const case1 = await deliveryOrder({ when: at(1, 13) });
  await recordOrderEarning(case1, { eligibleAt: case1.deliveredAt, note: 'Demo — Case 1' });
  const case2 = await deliveryOrder({ free: true, when: at(2, 20) });
  await recordOrderEarning(case2, { eligibleAt: case2.deliveredAt, note: 'Demo — Case 2 (free delivery)' });

  // Case 3 & 4: dine-in bills
  const table = await Table.create({ restaurantId: restaurant._id, identifier: 'D1' });
  const dineIn = async ({ channel, when }) => {
    const charges = computeCustomerCharges({
      orderType: 'dine_in',
      foodSubtotalPaise: 30000,
      restaurant: { gstRegistered: true },
      settings: pdfPricing,
    });
    const session = await TableSession.create({
      restaurantId: restaurant._id,
      tableId: table._id,
      status: 'paid',
      openedAt: new Date(when.getTime() - HOUR),
      closedAt: when,
    });
    const order = await Order.create({
      restaurantId: restaurant._id,
      tableSessionId: session._id,
      tableId: table._id,
      tableNumber: 'D1',
      type: 'dine_in',
      placedBy: 'guest',
      items: item,
      subtotal: 300,
      status: 'served',
      paymentStatus: 'paid',
      paymentMethod: channel === 'online' ? 'online' : 'cash',
      paymentChannel: channel,
    });
    await TableSession.updateOne({ _id: session._id }, { $push: { orders: order._id } });
    const bill = await Bill.create({
      restaurantId: restaurant._id,
      tableSessionId: session._id,
      tableId: table._id,
      tableNumber: 'D1',
      type: 'dine_in',
      subtotal: 300,
      gstPercent: 5,
      gstAmount: 15,
      platformFee: 12,
      grandTotal: 327,
      charges,
      status: 'paid',
      paidAt: when,
      paidBy: channel === 'online' ? 'online' : 'cash',
      paymentChannel: channel,
      ...(channel === 'online' ? { razorpayFee: 1042, razorpayTax: 159, razorpayPaymentId: 'pay_demo_bill' } : {}),
    });
    await recordBillSettlement(bill, { note: `Demo — dine-in ${channel}` });
  };
  await dineIn({ channel: 'online', when: at(2, 14) });
  await dineIn({ channel: 'counter', when: at(4, 21) });

  // Refund: paid online, the restaurant rejected it — the restaurant bears Razorpay's fee.
  const refunded = await deliveryOrder({
    when: at(5, 12),
    fields: {
      status: 'cancelled',
      cancelledAt: at(5, 12),
      cancelledBy: 'restaurant',
      cancellationReason: 'Restaurant is too busy right now',
      deliveredAt: null,
      paymentStatus: 'refunded',
      refundStatus: 'refunded',
      refund: {
        status: 'processed',
        cause: 'restaurant_reject',
        feeBorneBy: 'restaurant',
        amountPaise: 35700,
        razorpayRefundId: 'rfnd_demo',
        initiatedBy: 'system',
        initiatedAt: at(5, 12),
        processedAt: at(5, 13),
      },
    },
  });
  const refundEntry = await recordRefundGatewayFee(refunded, { cause: 'restaurant_reject', feeBorneBy: 'restaurant' });
  if (refundEntry) await RestaurantLedgerEntry.updateOne({ _id: refundEntry._id }, { $set: { eligibleAt: at(5, 12) } });

  // Cancelled by the customer after preparation started: no refund, the restaurant is paid.
  const cancelled = await deliveryOrder({
    when: at(2, 19),
    fields: {
      status: 'cancelled',
      cancelledAt: at(2, 19),
      cancelledBy: 'customer',
      cancellationReason: 'Cancelled by you after preparation started — no refund',
      deliveredAt: null,
    },
  });
  await recordOrderEarning(cancelled, {
    eligibleAt: cancelled.cancelledAt,
    note: 'Demo — cancelled by the customer after preparation started',
  });

  console.log(`Demo restaurant "${restaurant.name}" (${restaurant._id}) seeded for the week starting ${weekStart.toISOString()}`);
  console.log(`Restaurant portal login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);

  if (process.argv.includes('--generate')) {
    // Only the demo restaurant — never settle real restaurants' rows from a demo script.
    const { settlements } = await generateWeeklySettlements(weekStart, { restaurantIds: [restaurant._id] });
    const mine = settlements.find((s) => String(s.restaurantId) === String(restaurant._id));
    console.log(
      `Settlement generated: status ${mine?.status}${mine?.holdReason ? ` (${mine.holdReason})` : ''}, net payable ₹${((mine?.totals?.netPayable ?? 0) / 100).toFixed(2)}`
    );
  }
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
