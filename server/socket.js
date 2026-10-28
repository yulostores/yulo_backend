import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from './config/env.js';
import { redis } from './config/redis.js';
import Order from './models/Order.js';
import Restaurant from './models/Restaurant.js';
import StaffMember from './models/StaffMember.js';
import { isTokenRevoked } from './services/auth.service.js';
import * as liveMonitorService from './services/liveMonitor.service.js';
import {
  sweepExpiredOffers,
  sweepExpiredVegFleetSearches,
  sweepUnassignedOrders,
} from './services/deliveryAssignment.service.js';
import { expireUnansweredOrders } from './services/orderApproval.service.js';
import { runSessionSweep } from './services/activity.service.js';
import { markOfferDelivered } from './services/personalOffer.service.js';
import { liveRooms } from './services/liveEmit.service.js';
import { isLiveActivityEnabled } from './config/liveActivity.config.js';
import logger from './utils/logger.js';


// Presence sets live in Redis, which is optional (config/redis.js exports null without
// REDIS_URL). Without it — or with it unreachable — presence is simply not recorded: no rider
// can be offered an order automatically (deliveryAssignment.service.js) and the live-visitor
// push is skipped, but the server keeps running. A bare `redis.sadd` on null used to throw
// inside these handlers, and the 30-second live-stats interval crashed the process.
const presence = async (op, key, ...args) => {
  if (!redis) return op === 'smembers' ? [] : null;
  try {
    return await redis[op](key, ...args);
  } catch (err) {
    logger.warn({ err, op, key }, 'Redis presence update failed');
    return op === 'smembers' ? [] : null;
  }
};

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

// `backgroundJobs: false` is for the test harness only (test-utils/appHarness.mjs): it needs
// a live Socket.IO server so services can emit, but not the recurring sweeps below, which
// would keep a test process alive forever and touch Redis/Mongo on their own schedule.
export function initSocket(httpServer, { backgroundJobs = true } = {}) {
  // Same fix as app.js's cors() call: ALLOWED_ORIGINS=* must become `true` (dynamic reflection),
  // not the literal array ['*'], which Socket.IO's own engine.io CORS layer would never match
  // against a real browser's Origin header either.
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins.includes('*') ? true : allowedOrigins, credentials: true },
  });

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'socket connected');

    // `ack` is optional, like join_partner's: `{ ok: true }`, or `{ ok: false, code }`
    // (UNAUTHORIZED: bad token; FORBIDDEN: not this owner's restaurant) before the disconnect.
    // Portal builds that send no callback behave exactly as before.
    socket.on('join_restaurant', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const { restaurantId, token } = payload ?? {};
        const decoded = verifyUserToken(token);
        if (!decoded || decoded.role !== 'restaurant_owner') {
          reply({ ok: false, code: 'UNAUTHORIZED' });
          return socket.disconnect();
        }
        const owns = await Restaurant.exists({ _id: restaurantId, ownerId: decoded.userId });
        if (!owns) {
          reply({ ok: false, code: 'FORBIDDEN' });
          return socket.disconnect();
        }
        socket.join(`restaurant:${restaurantId}`);
        // Owner-only room: orders awaiting the restaurant's approval are emitted here and
        // nowhere else, since `restaurant:` is shared with waiter sockets. Live customer
        // activity and personal offers go here too, and only here (liveEmit.service.js).
        socket.join(`owner:${restaurantId}`);
        socket.data.restaurantId = restaurantId;
        await presence('sadd', 'live:active_restaurants', restaurantId);
        reply({ ok: true });
      } catch (err) {
        logger.error({ err }, 'join_restaurant failed');
        reply({ ok: false, code: 'UNAUTHORIZED' });
        socket.disconnect();
      }
    });

    // A signed-in customer's own channel for personal offers (live customer activity):
    // `offer_received` / `offer_updated` arrive in user:<userId>. The room comes from the token
    // alone — any userId in the payload is ignored. Refused → the ack says why
    // (DISABLED / UNAUTHORIZED / GUEST), then the socket is closed. `ack` is optional.
    //
    // Token expiry while connected: the access token is checked once, here. The socket keeps
    // its room until it disconnects, even after the token runs out (unlike staff screens,
    // closeAtTokenExpiry above). That is acceptable for this room — it only ever carries the
    // customer's own offers — and the app rejoins with a fresh token whenever it reconnects.
    // Re-auth on expiry is not built.
    socket.on('join_user', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const refuse = (code) => {
        reply({ ok: false, code });
        socket.disconnect();
      };
      try {
        if (!isLiveActivityEnabled()) return refuse('DISABLED');
        const token = payload?.token;
        const decoded = typeof token === 'string' ? verifyUserToken(token) : null;
        if (!decoded || (await isTokenRevoked(decoded, token))) return refuse('UNAUTHORIZED');
        if (decoded.role === 'guest') return refuse('GUEST');
        if (decoded.role !== 'customer') return refuse('UNAUTHORIZED');
        socket.join(liveRooms.userRoom(decoded.userId));
        socket.data.liveUserId = decoded.userId;
        reply({ ok: true });
      } catch (err) {
        logger.error({ err }, 'join_user failed');
        refuse('UNAUTHORIZED');
      }
    });

    // Delivery receipt for a personal offer, from a socket that joined as its customer. Only
    // the socket's own offers count; anything else is silently ignored (the reply is the same
    // either way, so it reveals nothing).
    socket.on('offer_ack', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (socket.data.liveUserId && isLiveActivityEnabled()) {
          await markOfferDelivered(socket.data.liveUserId, payload?.offerId);
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'offer_ack failed');
      }
      reply({ ok: true });
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

    socket.on('join_order', async (payload) => {
      try {
        const { orderId, token } = payload ?? {};
        const decoded = verifyUserToken(token);
        if (!decoded) return socket.disconnect();
        const order = await Order.findOne({ _id: orderId, userId: decoded.userId }).select('_id').lean();
        if (!order) return socket.disconnect();
        socket.join(`order:${orderId}`);
      } catch (err) {
        logger.error({ err }, 'join_order failed');
        socket.disconnect();
      }
    });

    // `ack` (optional — older app builds don't send one) tells the app whether it is now
    // reachable. A rider's access token lasts 15 minutes, and the app used to rejoin after a
    // reconnect with whatever token it held: an expired one got the socket dropped without a
    // word, socket.io-client never reconnects a socket the server closed, and the rider silently
    // stopped receiving offers while the app still said "Online". With the answer, the app
    // refreshes its token and joins again.
    socket.on('join_partner', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const decoded = verifyPartnerToken(payload?.token);
      if (!decoded) {
        reply({ ok: false, code: 'INVALID_TOKEN' });
        return socket.disconnect();
      }
      socket.join(`partner:${decoded.partnerId}`);
      socket.data.partnerId = decoded.partnerId;
      // Presence registry for auto-assignment eligibility — a partner must be actually
      // reachable over a socket to receive an order offer. Mirrors join_restaurant's
      // live:active_restaurants pattern below. deliveryAssignment.service.js (a later step)
      // reads this set to filter candidates, and emits offers into this same
      // `partner:{partnerId}` room.
      await presence('sadd', 'live:active_partners', decoded.partnerId);
      reply({ ok: true });
    });

    socket.on('disconnect', async (reason) => {
      logger.debug({ socketId: socket.id, reason }, 'socket disconnected');
      clearTimeout(socket.data.staffExpiryTimer);
      if (socket.data.restaurantId) {
        const room = io.sockets.adapter.rooms.get(`restaurant:${socket.data.restaurantId}`);
        if (!room || room.size === 0) {
          await presence('srem', 'live:active_restaurants', socket.data.restaurantId);
        }
      }
      if (socket.data.partnerId) {
        const room = io.sockets.adapter.rooms.get(`partner:${socket.data.partnerId}`);
        if (!room || room.size === 0) {
          await presence('srem', 'live:active_partners', socket.data.partnerId);
        }
      }
    });
  });

  if (!backgroundJobs) return io;

  setInterval(async () => {
    if (!redis) return;
    try {
      const ids = await presence('smembers', 'live:active_restaurants');
      for (const restaurantId of ids) {
        const stats = await liveMonitorService.getStats(restaurantId);
        io.to(`restaurant:${restaurantId}`).emit('live_visitor_update', stats);
      }
    } catch (err) {
      logger.error({ err }, 'live_visitor_update failed');
    }
  }, 30_000);

  // Catches order offers nobody ever "touches" again (app closed mid-offer, etc.) — see the
  // file-level comment above expireIfStale in deliveryAssignment.service.js for why a lazy
  // on-read check alone isn't sufficient. 5s keeps reassignment latency reasonably tight
  // against a ~20s offer window without excessive DB load.
  setInterval(() => {
    sweepExpiredOffers().catch((err) => logger.error({ err }, 'sweepExpiredOffers failed'));
    // Accepted orders nobody has been offered yet — no rider was connected at the time.
    sweepUnassignedOrders().catch((err) => logger.error({ err }, 'sweepUnassignedOrders failed'));
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
    // Live customer activity: idle / abandoned / ended / checkout_left. A no-op with the feature
    // off; skips a tick while the previous one is still running; never throws.
    void runSessionSweep();
  }, 60_000);

  // index.js closes this on shutdown.
  return io;
}

export const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};
