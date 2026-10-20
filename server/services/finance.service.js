import Bill from '../models/Bill.js';
import Order from '../models/Order.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import { splitInclusiveGst, toRupees } from '../utils/money.js';
import Restaurant from '../models/Restaurant.js';
import Payout from '../models/Payout.js';
import { getActiveSettings } from './financeSettings.service.js';

// The platform's cut of a revenue figure for these analytics. Was a flat
// PLATFORM_COMMISSION_PERCENT (15 %); the business model replaced commission with the
// settlement charge (Finance Settings → settlementChargePercent), so the same rate is used
// here until the finance dashboard is rebuilt on real settlement data (F6).
const commissionRate = async () => (await getActiveSettings()).settlementChargePercent / 100;
import { getPlatformPayoutTotal, getPlatformRiderTips } from './payout.service.js';

// Money in these analytics is rupees; rounded to the paisa so a rate × total never comes back
// as 25.060000000000002.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Months are the settlement time zone's calendar months (an order paid at 01:00 IST on the 1st
// is that month's, not the previous one's as a UTC month would make it).
const settlementTimezone = async () => (await getActiveSettings()).settlementCycle?.timezone ?? 'Asia/Kolkata';

// A dine-in Bill always has tableSessionId set (assembled from a TableSession, possibly
// batching several Orders); an online Bill (see billing.service.createOrderBill) always has
// orderId set instead. Bucketing on this is cheaper and more reliable than re-joining Order.
const BUCKET_EXPR = {
  $cond: [{ $ne: ['$tableSessionId', null] }, 'dineIn', 'online'],
};

const DEFAULT_RANGE_DAYS = 365;

const resolveRange = (from, to) => {
  const rangeTo = to ? new Date(to) : new Date();
  const rangeFrom = from
    ? new Date(from)
    : new Date(rangeTo.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
  return { rangeFrom, rangeTo };
};

// Yulo's own money for the range, summed from the ledger's frozen settlement lines (the same
// figures restaurants are settled on), by when each became settlement-eligible:
//   platform fees + delivery charges + settlement margin = Yulo revenue;
//   Razorpay's actual fees; the GST in it — food GST is the restaurant's liability, the 18 %
//   on Yulo's services (platform fee, delivery, settlement charge) is Yulo's.
// Rupees, rounded to the paisa, like the rest of this endpoint.
const EARNING_TYPES = ['order_earning', 'dine_in_earning', 'counter_platform_fee'];
const ledgerMoney = async ({ from, to }) => {
  const rows = await RestaurantLedgerEntry.find({ type: { $in: EARNING_TYPES }, eligibleAt: { $gte: from, $lte: to } })
    .select('type orderId billId breakdown')
    .lean();
  const orderIds = rows.filter((r) => r.orderId).map((r) => r.orderId);
  const billIds = rows.filter((r) => r.billId).map((r) => r.billId);
  const [orders, bills, { serviceGstPercent }] = await Promise.all([
    orderIds.length ? Order.find({ _id: { $in: orderIds } }).select('charges').lean() : [],
    billIds.length ? Bill.find({ _id: { $in: billIds } }).select('charges').lean() : [],
    getActiveSettings(),
  ]);
  const chargesOf = new Map([...orders, ...bills].map((d) => [String(d._id), d.charges ?? null]));

  const t = { platformFees: 0, deliveryCharges: 0, settlementCharges: 0, settlementMargin: 0, gatewayFees: 0, gatewayGst: 0,
    foodGst: 0, platformFeeGst: 0, deliveryGst: 0, settlementChargeGst: 0 };
  for (const r of rows) {
    const b = r.breakdown ?? {};
    const charges = chargesOf.get(String(r.orderId ?? r.billId)) ?? null;
    const platformFee = b.yuloMoney?.platformFee ?? 0;
    // Delivery Yulo was paid for: by the customer, or by the restaurant on a free delivery.
    const delivery = (b.yuloMoney?.deliveryCharge ?? 0) + (b.restaurantBorneDelivery ?? 0);
    t.platformFees += platformFee;
    t.deliveryCharges += delivery;
    t.settlementCharges += b.settlementCharge?.total ?? 0;
    t.settlementChargeGst += b.settlementCharge?.gst ?? 0;
    t.settlementMargin += b.yuloSettlementMargin ?? 0;
    t.gatewayFees += b.gateway?.total ?? 0;
    t.gatewayGst += b.gateway?.tax ?? 0;
    // The GST inside the fees, from the bill they were charged on (split from the
    // GST-inclusive amount when a line has no charges behind it).
    t.platformFeeGst += charges?.platformFee?.gst ?? splitInclusiveGst(platformFee, serviceGstPercent).gst;
    t.deliveryGst += delivery ? (charges?.delivery?.gst ?? splitInclusiveGst(delivery, serviceGstPercent).gst) : 0;
    if (r.type !== 'counter_platform_fee') t.foodGst += charges?.food?.gst ?? 0;
  }
  const yuloGst = t.platformFeeGst + t.deliveryGst + t.settlementChargeGst;
  return {
    yuloRevenue: toRupees(t.platformFees + t.deliveryCharges + t.settlementMargin),
    platformFees: toRupees(t.platformFees),
    deliveryCharges: toRupees(t.deliveryCharges),
    settlementCharges: toRupees(t.settlementCharges),
    settlementMargin: toRupees(t.settlementMargin),
    gatewayFees: toRupees(t.gatewayFees),
    gatewayGst: toRupees(t.gatewayGst),
    gst: {
      foodRestaurantLiability: toRupees(t.foodGst),
      yuloLiability: toRupees(yuloGst),
      yuloOnPlatformFees: toRupees(t.platformFeeGst),
      yuloOnDelivery: toRupees(t.deliveryGst),
      yuloOnSettlementCharges: toRupees(t.settlementChargeGst),
    },
    ledgerRows: rows.length,
  };
};

export const getFinanceOverview = async ({ from, to } = {}) => {
  const { rangeFrom, rangeTo } = resolveRange(from, to);

  // deliveryPartnerPayout is what riders cost Yulo (base + distance pay, incentives −
  // deductions). Customers' tips are passed to riders in full and are not Yulo's spending —
  // reported separately as riderTipsPassedThrough.
  const [byBucket, deliveryPartnerPayout, riderTipsPassedThrough, yulo] = await Promise.all([
    Bill.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: rangeFrom, $lte: rangeTo } } },
      { $group: { _id: BUCKET_EXPR, revenue: { $sum: '$grandTotal' } } },
    ]),
    getPlatformPayoutTotal({ from: rangeFrom, to: rangeTo, excludeTips: true }),
    getPlatformRiderTips({ from: rangeFrom, to: rangeTo }),
    ledgerMoney({ from: rangeFrom, to: rangeTo }),
  ]);

  const onlineRevenue = round2(byBucket.find((b) => b._id === 'online')?.revenue ?? 0);
  const dineInRevenue = round2(byBucket.find((b) => b._id === 'dineIn')?.revenue ?? 0);
  const grossRevenue = round2(onlineRevenue + dineInRevenue);
  const commissionRevenue = round2(grossRevenue * (await commissionRate()));
  const netPlatformProfit = round2(commissionRevenue - deliveryPartnerPayout);

  return {
    grossRevenue,
    onlineRevenue,
    dineInRevenue,
    deliveryPartnerPayout,
    riderTipsPassedThrough,
    commissionRevenue,
    netPlatformProfit,
    // From the ledger (see ledgerMoney): Yulo revenue, Razorpay fees and the GST split.
    yulo,
    range: { from: rangeFrom, to: rangeTo },
  };
};

export const getRevenueTrend = async ({ months = 12 } = {}) => {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const timezone = await settlementTimezone();

  const rows = await Bill.aggregate([
    { $match: { status: 'paid', paidAt: { $gte: since } } },
    {
      $group: {
        _id: { month: { $dateTrunc: { date: '$paidAt', unit: 'month', timezone } }, bucket: BUCKET_EXPR },
        revenue: { $sum: '$grandTotal' },
      },
    },
    { $sort: { '_id.month': 1 } },
  ]);

  const byMonth = new Map();
  for (const row of rows) {
    const key = row._id.month.toISOString();
    const point = byMonth.get(key) ?? { date: row._id.month, online: 0, dineIn: 0 };
    point[row._id.bucket] = round2(row.revenue);
    byMonth.set(key, point);
  }

  return [...byMonth.values()].sort((a, b) => a.date - b.date);
};

export const getEarningsVsSpending = async ({ months = 12 } = {}) => {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const timezone = await settlementTimezone();

  // Spending: weekly rider payouts only (a monthly row restates the same deliveries), by the
  // month their week starts in, without customers' tips (passed through, not Yulo's cost).
  const [revenueRows, payoutRows] = await Promise.all([
    Bill.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$paidAt', unit: 'month', timezone } },
          revenue: { $sum: '$grandTotal' },
        },
      },
    ]),
    Payout.aggregate([
      { $match: { periodType: 'weekly', periodStart: { $gte: since } } },
      {
        $group: {
          _id: { $dateTrunc: { date: '$periodStart', unit: 'month', timezone } },
          spending: { $sum: { $subtract: ['$netPayable', { $ifNull: ['$tips', 0] }] } },
        },
      },
    ]),
  ]);

  const rate = await commissionRate();
  const byMonth = new Map();
  for (const row of revenueRows) {
    const key = row._id.toISOString();
    byMonth.set(key, {
      date: row._id,
      earnings: round2(row.revenue * rate),
      spending: 0,
    });
  }
  for (const row of payoutRows) {
    const key = row._id.toISOString();
    const point = byMonth.get(key) ?? { date: row._id, earnings: 0, spending: 0 };
    point.spending = round2(row.spending);
    byMonth.set(key, point);
  }

  return [...byMonth.values()].sort((a, b) => a.date - b.date);
};

export const getRestaurantRevenueTable = async ({ page = 1, limit = 10, from, to } = {}) => {
  const { rangeFrom, rangeTo } = resolveRange(from, to);
  const periodLengthMs = rangeTo.getTime() - rangeFrom.getTime();
  const previousFrom = new Date(rangeFrom.getTime() - periodLengthMs);
  const previousTo = rangeFrom;

  const perRestaurant = async (matchFrom, matchTo) =>
    Bill.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: matchFrom, $lte: matchTo } } },
      {
        $group: {
          _id: { restaurantId: '$restaurantId', bucket: BUCKET_EXPR },
          revenue: { $sum: '$grandTotal' },
          orders: { $sum: 1 },
        },
      },
    ]);

  const [currentRows, previousRows] = await Promise.all([
    perRestaurant(rangeFrom, rangeTo),
    perRestaurant(previousFrom, previousTo),
  ]);

  const byRestaurant = new Map();
  for (const row of currentRows) {
    const id = row._id.restaurantId.toString();
    const entry = byRestaurant.get(id) ?? {
      restaurantId: row._id.restaurantId,
      onlineRevenue: 0,
      dineInRevenue: 0,
      orders: 0,
    };
    entry[row._id.bucket === 'online' ? 'onlineRevenue' : 'dineInRevenue'] = row.revenue;
    entry.orders += row.orders;
    byRestaurant.set(id, entry);
  }

  const previousTotals = new Map();
  for (const row of previousRows) {
    const id = row._id.restaurantId.toString();
    previousTotals.set(id, (previousTotals.get(id) ?? 0) + row.revenue);
  }

  const rate = await commissionRate();
  const allEntries = [...byRestaurant.values()].map((entry) => {
    const totalRevenue = entry.onlineRevenue + entry.dineInRevenue;
    const previousRevenue = previousTotals.get(entry.restaurantId.toString()) ?? 0;
    const growthPercent =
      previousRevenue === 0 ? null : ((totalRevenue - previousRevenue) / previousRevenue) * 100;

    return {
      ...entry,
      onlineRevenue: round2(entry.onlineRevenue),
      dineInRevenue: round2(entry.dineInRevenue),
      totalRevenue: round2(totalRevenue),
      commission: round2(totalRevenue * rate),
      growthPercent,
    };
  });

  allEntries.sort((a, b) => b.totalRevenue - a.totalRevenue);

  const total = allEntries.length;
  const skip = (Number(page) - 1) * Number(limit);
  const pageEntries = allEntries.slice(skip, skip + Number(limit));

  const restaurants = await Restaurant.find({
    _id: { $in: pageEntries.map((e) => e.restaurantId) },
  })
    .select('name address.city approvalStatus')
    .lean();
  const restaurantMap = new Map(restaurants.map((r) => [r._id.toString(), r]));

  const rows = pageEntries.map((entry) => {
    const restaurant = restaurantMap.get(entry.restaurantId.toString());
    return {
      restaurantId: entry.restaurantId,
      name: restaurant?.name ?? 'Unknown',
      city: restaurant?.address?.city ?? '—',
      orders: entry.orders,
      onlineRevenue: entry.onlineRevenue,
      dineInRevenue: entry.dineInRevenue,
      totalRevenue: entry.totalRevenue,
      commission: entry.commission,
      growthPercent: entry.growthPercent,
      status: restaurant?.approvalStatus ?? 'unknown',
    };
  });

  return {
    rows,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  };
};
