import mongoose from 'mongoose';
import Order from '../models/Order.js';
import TableSession from '../models/TableSession.js';
import User from '../models/User.js';
import Discount from '../models/Discount.js';
import { redis } from '../config/redis.js';
import { getIO } from '../socket.js';
import logger from '../utils/logger.js';

// Live visitor numbers live only in Redis. Without it (local dev, a Redis outage) they read as
// zero and are not recorded — the dashboard keeps working on its MongoDB numbers.
export const trackVisitor = async ({ restaurantId, sessionId, userId, cartItems, intentScore }) => {
  if (!redis) return;
  const key = `live:visitor:${restaurantId}:${sessionId}`;
  await redis.hset(key, {
    userId: userId || '',
    cartItems: JSON.stringify(cartItems || []),
    intentScore: intentScore || 0,
    updatedAt: Date.now(),
  });
  await redis.expire(key, 300);
  await redis.incr(`live:count:${restaurantId}`);
};

export const getActiveVisitors = async (restaurantId) => {
  if (!redis) return { visitors: [], count: 0 };
  const keys = await redis.keys(`live:visitor:${restaurantId}:*`);

  if (!keys.length) return { visitors: [], count: 0 };

  const rawVisitors = await Promise.all(keys.map((key) => redis.hgetall(key)));

  const visitors = rawVisitors
    .filter(Boolean)
    .map((v, i) => ({
      sessionId: keys[i].split(':').pop(),
      userId: v.userId || null,
      cartItems: JSON.parse(v.cartItems || '[]'),
      intentScore: parseFloat(v.intentScore) || 0,
      updatedAt: parseInt(v.updatedAt, 10) || 0,
    }));

  const userIds = [...new Set(visitors.map((v) => v.userId).filter(Boolean))];

  if (userIds.length) {
    const users = await User.find({ _id: { $in: userIds } })
      .select('name email phone')
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    visitors.forEach((v) => {
      if (v.userId) v.user = userMap.get(v.userId) || null;
    });
  }

  return { visitors, count: visitors.length };
};

export const getStats = async (restaurantId) => {
  const today = new Date().toISOString().slice(0, 10);

  const [openSessions, pendingOrders, countRaw, gmvRaw] = await Promise.all([
    TableSession.countDocuments({ restaurantId, status: 'open' }),
    Order.countDocuments({ restaurantId, status: { $in: ['placed', 'confirmed', 'preparing'] } }),
    redis ? redis.get(`live:count:${restaurantId}`) : null,
    redis ? redis.get(`live:gmv:${restaurantId}:${today}`) : null,
  ]);

  return {
    restaurantId,
    openSessions,
    pendingOrders,
    activeVisitors: parseInt(countRaw, 10) || 0,
    gmv: parseFloat(gmvRaw) || 0,
  };
};

export const updateGMV = async (restaurantId, amount) => {
  const today = new Date().toISOString().slice(0, 10);
  if (!redis) return;
  const key = `live:gmv:${restaurantId}:${today}`;
  await redis.incrbyfloat(key, amount);
  await redis.expire(key, 86400);
};

export const getRepeatVisitors = async (restaurantId) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);
  return Order.aggregate([
    { $match: { restaurantId: rid, userId: { $ne: null } } },
    { $group: { _id: '$userId', orderCount: { $sum: 1 }, lastOrder: { $max: '$createdAt' } } },
    { $match: { orderCount: { $gt: 1 } } },
    { $sort: { orderCount: -1 } },
    { $limit: 50 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: { name: 1, email: 1, phone: 1 } }],
      },
    },
    { $unwind: '$user' },
    { $project: { user: 1, orderCount: 1, lastOrder: 1 } },
  ]);
};

export const createTargetedOffer = async ({ restaurantId, offerData }) => {
  const discount = await Discount.create({
    restaurantId,
    ...offerData,
    status: 'active',
  });

  try {
    getIO()
      .to(`restaurant:${restaurantId}`)
      .emit('targeted_offer', { discountId: discount._id, code: discount.code, offerName: discount.offerName });
  } catch (err) {
    logger.error({ err }, 'Failed to emit targeted_offer');
  }

  return discount;
};
