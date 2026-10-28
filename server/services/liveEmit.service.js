import { getIO } from '../socket.js';
import { isLiveActivityEnabled, isLiveActivityEnabledFor } from '../config/liveActivity.config.js';
import logger from '../utils/logger.js';

// The only place live customer activity touches Socket.IO rooms, so moving to a Redis adapter
// (several API instances) later is a change here and nowhere else.
//
//   owner:<restaurantId>  the restaurant's owners only. NOT restaurant:<id> — join_waiter puts
//                         every waiter's socket in that one, and nothing about customers'
//                         activity or offers may reach staff devices.
//   user:<userId>         one signed-in customer (join_user in socket.js).
//
// Every emit is a no-op while the feature (or the pilot allow-list) is off for the restaurant,
// or when no Socket.IO server is running (scripts, most tests). Nothing here ever throws.

// Keys no live-activity payload may carry, at any depth.
const PII_KEYS = new Set(['phone', 'email', 'address', 'location', 'lat', 'lng', 'payment', 'card', 'upi', 'token']);

const ownerRoom = (restaurantId) => `owner:${restaurantId}`;
const userRoom = (userId) => `user:${userId}`;

let emitHook = null;

/** Tests only: `fn(room, event, payload)` sees every emit that would go out; null removes it. */
export const __onEmitForTests = (fn) => {
  emitHook = fn;
};

const ioOrNull = () => {
  try {
    return getIO();
  } catch {
    return null;
  }
};

const plain = (value) => (value && typeof value.toJSON === 'function' && !(value instanceof Date) ? value.toJSON() : value);

/**
 * A copy of `payload` without any deny-listed key (case-insensitive, at any depth); each one
 * dropped is logged as a warning — it means a payload builder is wrong.
 */
export const assertNoPii = (payload, path = '') => {
  const value = plain(payload);
  if (Array.isArray(value)) return value.map((item, i) => assertNoPii(item, `${path}[${i}]`));
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const clean = {};
  for (const [key, inner] of Object.entries(value)) {
    if (PII_KEYS.has(key.toLowerCase())) {
      logger.warn({ key: `${path}${key}` }, 'live activity: dropped a personal field from a socket payload');
      continue;
    }
    clean[key] = assertNoPii(inner, `${path}${key}.`);
  }
  return clean;
};

const emit = (room, event, payload) => {
  try {
    const io = ioOrNull();
    if (!io) return;
    const safe = assertNoPii(payload);
    emitHook?.(room, event, safe);
    io.to(room).emit(event, safe);
  } catch (err) {
    logger.warn({ err: err.message, event }, 'live activity: emit failed');
  }
};

/** To the restaurant's owners (owner:<id>) — only while the feature is on for it. */
export const emitToOwners = (restaurantId, event, payload) => {
  if (!restaurantId || !isLiveActivityEnabledFor(restaurantId)) return;
  emit(ownerRoom(restaurantId), event, payload);
};

/** To one customer's sockets (user:<id>); `restaurantId` (when the payload has one) gates it too. */
export const emitToUser = (userId, event, payload, { restaurantId } = {}) => {
  if (!userId || !isLiveActivityEnabled()) return;
  if (restaurantId && !isLiveActivityEnabledFor(restaurantId)) return;
  emit(userRoom(userId), event, payload);
};

/**
 * Whether any owner socket is in the room (in this process), so payloads that cost queries
 * (session rows with eligibility) aren't built for nobody. With a Redis adapter this must ask
 * the adapter instead — it is here for that reason. True while a test hook is installed.
 */
export const ownersListening = (restaurantId) => {
  if (!restaurantId || !isLiveActivityEnabledFor(restaurantId)) return false;
  if (emitHook) return true;
  const io = ioOrNull();
  return Boolean(io?.sockets.adapter.rooms.get(ownerRoom(restaurantId))?.size);
};

/** The room names, for socket.js's joins. */
export const liveRooms = { ownerRoom, userRoom };
