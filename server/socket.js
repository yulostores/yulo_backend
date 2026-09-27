import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { redis } from './config/redis.js';
import Order from './models/Order.js';
import Restaurant from './models/Restaurant.js';
import StaffMember from './models/StaffMember.js';
import { isTokenRevoked } from './services/auth.service.js';
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

// Room every socket of one staff member joins, so their open screens can be closed at once
// when the owner ends their sessions (controllers/owner/staff.controller.js).
const staffRoom = (staffId) => `staff:${staffId}`;

// Everything middleware/authenticateStaff.js checks on an HTTP request, for a socket that
// wants a staff room: a valid token of the right role for this restaurant, not revoked
// (logged out), for a member who is still active and whose sessions haven't been ended
// since (phone changed / deactivated — the `sv` sessionVersion). Null when any fails.
//
// The socket joins the member's own room BEFORE the member is read. The owner ending their
// sessions writes the member and then disconnects that room (controllers/owner/
// staff.controller.js), so whichever happens first, this socket is caught: either the read
// below already sees the ended session, or the socket is in the room when it is cleared.
// Checked the other way round, a join in flight could slip in just after the disconnect.
const authorizeStaffSocket = async (socket, { staffToken, restaurantId, role }) => {
  const decoded = verifyStaffToken(staffToken);
  if (!decoded || decoded.role !== role) return null;
  if (typeof restaurantId !== 'string' || decoded.restaurantId !== restaurantId) return null;
  if (await isTokenRevoked(decoded, staffToken)) return null;
  socket.join(staffRoom(decoded.staffId));
  const staff = await StaffMember.findById(decoded.staffId).select('restaurantId isActive sessionVersion').lean();
  if (!staff?.isActive || String(staff.restaurantId) !== restaurantId) return null;
  if (decoded.sv !== (staff.sessionVersion ?? 0)) return null;
  // Same as the HTTP side: no floor or kitchen feed for a suspended restaurant.
  const restaurant = await Restaurant.findById(restaurantId).select('isActive approvalStatus').lean();
  if (!restaurant?.isActive || restaurant.approvalStatus !== 'active') return null;
  return decoded;
};

// A staff session lasts exactly 24h (services/auth.service.js). A kitchen or floor screen
// left open would otherwise keep receiving orders on a socket that joined with a token long
// since expired, so the socket is closed the moment its token runs out.
const closeAtTokenExpiry = (socket, decoded) => {
  clearTimeout(socket.data.staffExpiryTimer);
  const ms = decoded.exp * 1000 - Date.now();
  if (ms <= 0) return socket.disconnect(true);
  // setTimeout caps at ~24.8 days; a staff token is 24h, well inside it.
  socket.data.staffExpiryTimer = setTimeout(() => socket.disconnect(true), ms);
};

export const disconnectStaffSockets = (staffId) => {
  if (!io) return;
  io.in(staffRoom(String(staffId))).disconnectSockets(true);
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

    // The try/catch matters: these handlers are async, so a throw (a bad payload, a
    // Redis/DB hiccup) would otherwise be an unhandled rejection.
    socket.on('join_kitchen', async (payload) => {
      try {
        // Destructured in here: a `null` payload skips a parameter default and would throw
        // outside the try — an unhandled rejection that takes the whole server down.
        const { restaurantId, staffToken } = payload ?? {};
        const decoded = await authorizeStaffSocket(socket, { staffToken, restaurantId, role: 'chef' });
        if (!decoded) return socket.disconnect();
        socket.join(`kitchen:${restaurantId}`);
        closeAtTokenExpiry(socket, decoded);
      } catch (err) {
        logger.error({ err }, 'join_kitchen failed');
        socket.disconnect();
      }
    });

    socket.on('join_waiter', async (payload) => {
      try {
        // Destructured in here: a `null` payload skips a parameter default and would throw
        // outside the try — an unhandled rejection that takes the whole server down.
        const { restaurantId, staffToken } = payload ?? {};
        const decoded = await authorizeStaffSocket(socket, { staffToken, restaurantId, role: 'waiter' });
        if (!decoded) return socket.disconnect();
        socket.join(`restaurant:${restaurantId}`);
        // Waiters-only room: where an order the restaurant just accepted is announced
        // (notify.service.js's orderAccepted), without echoing it back to the owner.
        socket.join(`floor:${restaurantId}`);
        socket.join(`waiter:${restaurantId}:${decoded.staffId}`);
        closeAtTokenExpiry(socket, decoded);
      } catch (err) {
        logger.error({ err }, 'join_waiter failed');
        socket.disconnect();
      }
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
      clearTimeout(socket.data.staffExpiryTimer);
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
