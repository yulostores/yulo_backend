import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import { redis } from '../config/redis.js';
import { enrichOrders } from './orderView.service.js';
import { AWAITING_ONLINE_PAYMENT } from './orderApproval.service.js';
import { dayBounds, monthBounds } from '../utils/week.js';
import { now } from '../utils/clock.js';

// The owner dashboard's windows (API.md § Owner — Dashboard), drawn in India time — the
// server's own midnight is 05:30 IST on a UTC host, which dropped every order placed between
// midnight and 05:30 from "today". today: the calendar day; week / month: the last 7 / 30
// calendar days including today; year: the last 12 calendar months including this one.
const TZ = 'Asia/Kolkata';
const DAY_MS = 24 * 60 * 60 * 1000;
export const DASHBOARD_PERIODS = ['today', 'week', 'month', 'year'];
const normalizePeriod = (period) => (period === 'day' ? 'today' : DASHBOARD_PERIODS.includes(period) ? period : null);

const periodStart = (period, at) => {
  if (period === 'today') return dayBounds(at, { timezone: TZ }).start;
  if (period === 'week') return dayBounds(at.getTime() - 6 * DAY_MS, { timezone: TZ }).start;
  if (period === 'month') return dayBounds(at.getTime() - 29 * DAY_MS, { timezone: TZ }).start;
  // year: back 11 months from this month's first day.
  let start = monthBounds(at, { timezone: TZ }).start;
  for (let i = 0; i < 11; i += 1) start = monthBounds(start.getTime() - 1, { timezone: TZ }).start;
  return start;
};

const round2 = (n) => Math.round(n * 100) / 100;

export const getKPIs = async (restaurantId, period = 'today', at = now()) => {
  const p = normalizePeriod(period) ?? 'today';
  const since = periodStart(p, at);
  const rid = new mongoose.Types.ObjectId(restaurantId);
  const inWindow = { restaurantId: rid, createdAt: { $gte: since }, $nor: [AWAITING_ONLINE_PAYMENT] };

  const [byType, revenueResult, firstOrders, liveRaw, restaurant] = await Promise.all([
    Order.aggregate([
      { $match: inWindow },
      {
        $group: {
          _id: null,
          dineIn: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$type', 'dine_in'] }] }, 1, 0] } },
          delivery: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$type', 'delivery'] }] }, 1, 0] } },
          takeaway: { $sum: { $cond: [{ $and: [{ $ne: ['$status', 'cancelled'] }, { $eq: ['$type', 'takeaway'] }] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        },
      },
    ]),
    Order.aggregate([
      { $match: { restaurantId: rid, paymentStatus: 'paid', status: { $ne: 'cancelled' }, createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$subtotal' }, count: { $sum: 1 } } },
    ]),
    // A new customer is one whose first order here falls inside the window.
    Order.aggregate([
      { $match: { restaurantId: rid, userId: { $ne: null }, $nor: [AWAITING_ONLINE_PAYMENT] } },
      { $group: { _id: '$userId', first: { $min: '$createdAt' } } },
      { $match: { first: { $gte: since } } },
      { $count: 'n' },
    ]),
    // Live visitors are Redis-only; without Redis they read as 0 rather than failing the KPIs.
    redis ? redis.get(`live:count:${restaurantId}`) : null,
    Restaurant.findById(restaurantId).select('avgRating totalRatings').lean(),
  ]);

  const counts = byType[0] ?? { dineIn: 0, delivery: 0, takeaway: 0, cancelled: 0 };
  const orders = counts.dineIn + counts.delivery + counts.takeaway;
  const revenue = revenueResult[0]?.total ?? 0;
  const paidOrders = revenueResult[0]?.count ?? 0;

  return {
    revenue,
    orders,
    avgOrderValue: paidOrders ? round2(revenue / paidOrders) : 0,
    dineIn: counts.dineIn,
    delivery: counts.delivery,
    takeaway: counts.takeaway,
    cancelledOrders: counts.cancelled,
    newCustomers: firstOrders[0]?.n ?? 0,
    period: p,
    // Kept for older clients: every order in the window, cancelled ones included.
    totalOrders: orders + counts.cancelled,
    liveCount: parseInt(liveRaw, 10) || 0,
    avgRating: restaurant?.avgRating ?? 0,
    totalRatings: restaurant?.totalRatings ?? 0,
  };
};

// The chart's slots, oldest first, each with the key Mongo's $dateToString gives it and the
// label the bar shows: hours for today, days for week/month, months for year.
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const weekdayLabel = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });
const monthLabel = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, month: 'short' });

const chartSlots = (period, since) => {
  if (period === 'today') {
    return Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, '0'), label: hourLabel(h) }));
  }
  if (period === 'year') {
    const slots = [];
    let start = since;
    for (let i = 0; i < 12; i += 1) {
      slots.push({ key: dayKey.format(start).slice(0, 7), label: monthLabel.format(start) });
      start = new Date(monthBounds(start, { timezone: TZ }).end.getTime() + 1);
    }
    return slots;
  }
  const days = period === 'week' ? 7 : 30;
  return Array.from({ length: days }, (_, i) => {
    // Noon of each day, so the key never lands on the wrong side of midnight.
    const d = new Date(since.getTime() + i * DAY_MS + 12 * 60 * 60 * 1000);
    return { key: dayKey.format(d), label: period === 'week' ? weekdayLabel.format(d) : dayLabel.format(d) };
  });
};

const BUCKET_FORMAT = { today: '%H', week: '%Y-%m-%d', month: '%Y-%m-%d', year: '%Y-%m' };

// Parallel arrays, as API.md documents and the dashboard reads: { labels, revenue, orders }.
export const getSalesChart = async (restaurantId, period = 'week', at = now()) => {
  const p = normalizePeriod(period) ?? 'week';
  const since = periodStart(p, at);
  const rid = new mongoose.Types.ObjectId(restaurantId);

  const rows = await Order.aggregate([
    { $match: { restaurantId: rid, paymentStatus: 'paid', status: { $ne: 'cancelled' }, createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: BUCKET_FORMAT[p], date: '$createdAt', timezone: TZ } },
        revenue: { $sum: '$subtotal' },
        orders: { $sum: 1 },
      },
    },
  ]);
  const byKey = new Map(rows.map((r) => [r._id, r]));
  const slots = chartSlots(p, since);
  return {
    labels: slots.map((s) => s.label),
    revenue: slots.map((s) => round2(byKey.get(s.key)?.revenue ?? 0)),
    orders: slots.map((s) => byKey.get(s.key)?.orders ?? 0),
    period: p,
  };
};

export const getTopItems = (restaurantId, limit = 5, period = null, at = now()) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);
  const p = normalizePeriod(period);
  const since = p ? { createdAt: { $gte: periodStart(p, at) } } : {};

  return Order.aggregate([
    { $match: { restaurantId: rid, paymentStatus: 'paid', status: { $ne: 'cancelled' }, ...since } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.menuItemId',
        name: { $first: '$items.name' },
        totalQty: { $sum: '$items.quantity' },
        totalRevenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
      },
    },
    { $sort: { totalQty: -1 } },
    { $limit: limit },
  ]);
};

// The dashboard's live activity feed. Enriched so each row can name the table it came
// from and the staff member who took it — without that the feed lists orders the owner
// has no way to place on the floor.
export const getRecentOrders = async (restaurantId, limit = 10) => {
  const orders = await Order.find({ restaurantId, $nor: [AWAITING_ONLINE_PAYMENT] })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return enrichOrders(orders);
};

export const getStatusBreakdown = (restaurantId) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);

  return Order.aggregate([
    { $match: { restaurantId: rid, $nor: [AWAITING_ONLINE_PAYMENT] } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
};
