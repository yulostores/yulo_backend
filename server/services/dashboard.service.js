import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import { redis } from '../config/redis.js';
import { enrichOrders } from './orderView.service.js';

export const getKPIs = async (restaurantId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rid = new mongoose.Types.ObjectId(restaurantId);

  const [totalOrders, revenueResult, liveRaw, restaurant] = await Promise.all([
    Order.countDocuments({ restaurantId: rid, createdAt: { $gte: today } }),
    Order.aggregate([
      { $match: { restaurantId: rid, paymentStatus: 'paid', createdAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: '$subtotal' } } },
    ]),
    redis.get(`live:count:${restaurantId}`),
    Restaurant.findById(restaurantId).select('avgRating totalRatings').lean(),
  ]);

  return {
    totalOrders,
    revenue: revenueResult[0]?.total ?? 0,
    liveCount: parseInt(liveRaw, 10) || 0,
    avgRating: restaurant?.avgRating ?? 0,
    totalRatings: restaurant?.totalRatings ?? 0,
  };
};

const PERIOD_DAYS = { today: 1, day: 1, week: 7, month: 30, year: 365 };

export const getSalesChart = (restaurantId, period = 'week') => {
  const days = PERIOD_DAYS[period] ?? 7;
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rid = new mongoose.Types.ObjectId(restaurantId);

  return Order.aggregate([
    { $match: { restaurantId: rid, paymentStatus: 'paid', createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' } },
        revenue: { $sum: '$subtotal' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
};

export const getTopItems = (restaurantId, limit = 5) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);

  return Order.aggregate([
    { $match: { restaurantId: rid, paymentStatus: 'paid' } },
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
  const orders = await Order.find({ restaurantId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return enrichOrders(orders);
};

export const getStatusBreakdown = (restaurantId) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);

  return Order.aggregate([
    { $match: { restaurantId: rid } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
};
