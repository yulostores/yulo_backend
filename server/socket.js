import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { redis } from './config/redis.js';
import Order from './models/Order.js';
import Restaurant from './models/Restaurant.js';
import * as liveMonitorService from './services/liveMonitor.service.js';
import { sweepExpiredOffers, sweepExpiredVegFleetSearches } from './services/deliveryAssignment.service.js';
import { expireUnansweredOrders } from './services/orderApproval.service.js';
import logger from './utils/logger.js';

let io;

const verifyUserToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    return null;
  }
};

const verifyStaffToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_STAFF_SECRET);
  } catch {
    return null;
  }
};

const verifyPartnerToken = (token) => {
  try {
    return jwt.verify(token, env.JWT_PARTNER_SECRET);
  } catch {
    return null;
  }
};

export function initSocket(httpServer) {
  // Same fix as app.js's cors() call: ALLOWED_ORIGINS=* must become `true` (dynamic reflection),
  // not the literal array ['*'], which Socket.IO's own engine.io CORS layer would never match
  // against a real browser's Origin header either.
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins.includes('*') ? true : allowedOrigins, credentials: true },
  });

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'socket connected');

    socket.on('join_restaurant', async ({ restaurantId, token }) => {
      const decoded = verifyUserToken(token);
      if (!decoded || decoded.role !== 'restaurant_owner') return socket.disconnect();
      const owns = await Restaurant.exists({ _id: restaurantId, ownerId: decoded.userId });
      if (!owns) return socket.disconnect();
      socket.join(`restaurant:${restaurantId}`);
      // Owner-only room: orders awaiting the restaurant's approval are emitted here and
      // nowhere else, since `restaurant:` is shared with waiter sockets.
      socket.join(`owner:${restaurantId}`);
      socket.data.restaurantId = restaurantId;
      await redis.sadd('live:active_restaurants', restaurantId);
    });

    socket.on('join_kitchen', async ({ restaurantId, staffToken }) => {
      const decoded = verifyStaffToken(staffToken);
      if (!decoded || decoded.role !== 'chef') return socket.disconnect();
      if (decoded.restaurantId !== restaurantId) return socket.disconnect();
      socket.join(`kitchen:${restaurantId}`);
    });

    socket.on('join_waiter', async ({ restaurantId, staffToken }) => {
      const decoded = verifyStaffToken(staffToken);
      if (!decoded || decoded.role !== 'waiter') return socket.disconnect();
      if (decoded.restaurantId !== restaurantId) return socket.disconnect();
      socket.join(`restaurant:${restaurantId}`);
      // Waiters-only room: where an order the restaurant just accepted is announced
      // (notify.service.js's orderAccepted), without echoing it back to the owner.
      socket.join(`floor:${restaurantId}`);
      socket.join(`waiter:${restaurantId}:${decoded.staffId}`);
    });

    socket.on('join_order', async ({ orderId, token }) => {
      const decoded = verifyUserToken(token);
      if (!decoded) return socket.disconnect();
      const order = await Order.findOne({ _id: orderId, userId: decoded.userId }).lean();
      if (!order) return socket.disconnect();
      socket.join(`order:${orderId}`);
    });

    socket.on('join_partner', async ({ token }) => {
      const decoded = verifyPartnerToken(token);
      if (!decoded) return socket.disconnect();
      socket.join(`partner:${decoded.partnerId}`);
      socket.data.partnerId = decoded.partnerId;
      // Presence registry for auto-assignment eligibility — a partner must be actually
      // reachable over a socket to receive an order offer. Mirrors join_restaurant's
      // live:active_restaurants pattern below. deliveryAssignment.service.js (a later step)
      // reads this set to filter candidates, and emits offers into this same
      // `partner:{partnerId}` room.
      await redis.sadd('live:active_partners', decoded.partnerId);
    });

    socket.on('disconnect', async (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'socket disconnected');
      if (socket.data.restaurantId) {
        const room = io.sockets.adapter.rooms.get(`restaurant:${socket.data.restaurantId}`);
        if (!room || room.size === 0) {
          await redis.srem('live:active_restaurants', socket.data.restaurantId);
        }
      }
      if (socket.data.partnerId) {
        const room = io.sockets.adapter.rooms.get(`partner:${socket.data.partnerId}`);
        if (!room || room.size === 0) {
          await redis.srem('live:active_partners', socket.data.partnerId);
        }
      }
    });
  });

  setInterval(async () => {
    const ids = await redis.smembers('live:active_restaurants');
    for (const restaurantId of ids) {
      const stats = await liveMonitorService.getStats(restaurantId);
      io.to(`restaurant:${restaurantId}`).emit('live_visitor_update', stats);
    }
  }, 30_000);

  // Catches order offers nobody ever "touches" again (app closed mid-offer, etc.) — see the
  // file-level comment above expireIfStale in deliveryAssignment.service.js for why a lazy
  // on-read check alone isn't sufficient. 5s keeps reassignment latency reasonably tight
  // against a ~20s offer window without excessive DB load.
  setInterval(() => {
    sweepExpiredOffers().catch((err) => logger.error({ err }, 'sweepExpiredOffers failed'));
    // Piggybacks on this same interval rather than a second scheduler — keeps
    // veg-fleet-only orders actively retrying assignment (not just waiting on the next
    // offer-expiry) and auto-extends the countdown once vegFleetSearchDeadline passes
    // with no customer decision. See its own comment for why both are folded in here.
    sweepExpiredVegFleetSearches().catch((err) => logger.error({ err }, 'sweepExpiredVegFleetSearches failed'));
  }, 5_000);

  // Customer orders nobody at the restaurant answered within ORDER_APPROVAL_TIMEOUT_MINUTES
  // are cancelled so the customer isn't left waiting forever (orderApproval.service.js). A
  // minute is plenty of resolution for a timeout measured in minutes.
  setInterval(() => {
    expireUnansweredOrders().catch((err) => logger.error({ err }, 'expireUnansweredOrders failed'));
  }, 60_000);
}

export const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};
