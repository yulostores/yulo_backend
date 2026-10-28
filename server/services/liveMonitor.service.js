import mongoose from 'mongoose';
import Order from '../models/Order.js';
import TableSession from '../models/TableSession.js';
import CustomerSession from '../models/CustomerSession.js';
import { redis } from '../config/redis.js';
import { LIST_LIMITS, OPEN_SESSION_STATUSES, isLiveActivityEnabledFor } from '../config/liveActivity.config.js';
import { displayNameFor, liveSessionScope } from './activity.service.js';
import { toSessionRow } from './liveSession.serializer.js';

// Who is on the restaurant right now: its open live-activity sessions (active / idle), newest
// activity first — the same rows the live dashboard shows, with the key names this endpoint
// always had (`userId`, `name`, `lastSeen` in epoch seconds, `tableId`) kept for the portal's
// current Live Monitor screens until the new dashboard replaces them. First name only, never
// phone or email; opted-out customers' sessions are hidden. Empty while the feature is off.
export const getActiveVisitors = async (restaurantId) => {
  if (!isLiveActivityEnabledFor(restaurantId)) return { visitors: [], count: 0 };
  const sessions = await CustomerSession.find({
    ...liveSessionScope(new mongoose.Types.ObjectId(String(restaurantId))),
    status: { $in: OPEN_SESSION_STATUSES },
  })
    .sort({ lastActivityAt: -1, _id: -1 })
    .limit(LIST_LIMITS.sessionsMax)
    .lean();
  const visitors = sessions.map((session) => ({
    ...toSessionRow(session),
    sessionId: String(session._id),
    // The portal keys its list on `userId`. It gets the visit's id, not the customer's: owners
    // never see who a customer is beyond the first name (liveSession.serializer.js).
    userId: String(session._id),
    name: session.displayName,
    lastSeen: Math.floor(session.lastActivityAt.getTime() / 1000),
    tableId: null,
    cartItems: (session.cart?.items ?? []).map((line) => ({ name: line.name, qty: line.qty })),
    updatedAt: session.lastActivityAt.getTime(),
  }));
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

// Customers with more than one order here: first name and order count only — never email or
// phone (decided 28 Oct 2026, the same rule as the live dashboard). `_id` keeps the key the
// portal lists by.
export const getRepeatVisitors = async (restaurantId) => {
  const rid = new mongoose.Types.ObjectId(restaurantId);
  const rows = await Order.aggregate([
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
        pipeline: [{ $project: { name: 1, role: 1 } }],
      },
    },
    { $unwind: '$user' },
  ]);
  return rows.map((row) => ({
    _id: row._id,
    name: displayNameFor(row.user),
    orderCount: row.orderCount,
    lastOrder: row.lastOrder,
  }));
};
