import mongoose from 'mongoose';
import User from '../models/User.js';
import Order from '../models/Order.js';
import CustomerSession, { sessionExpiresAt, sessionStatusFields } from '../models/CustomerSession.js';
import ActivityEvent from '../models/ActivityEvent.js';
import Discount from '../models/Discount.js';
import Cart from '../models/Cart.js';
import Table from '../models/Table.js';
import * as cartService from './cart.service.js';
import { redis } from '../config/redis.js';
import {
  COALESCE,
  OPEN_SESSION_STATUSES,
  SWEEP,
  REDIS_PREFIX,
  SEARCH_ATTRIBUTION_MS,
  SESSION_TIMINGS,
  TEXT_LIMITS,
  isLiveActivityEnabled,
  isLiveActivityEnabledFor,
} from '../config/liveActivity.config.js';
import { now } from '../utils/clock.js';
import { toPaise } from '../utils/money.js';
import { createBatch, publishSessionChange, publishSessions } from './liveBroadcast.service.js';
import logger from '../utils/logger.js';

// Live customer activity capture. Existing endpoints call `record(...)` AFTER they have sent
// their response (`void activityService.record(...)`), so recording can never fail or slow the
// customer's request: every error is swallowed here and logged with ids only. There is no
// public "track" endpoint — events come only from the server-side hooks.
//
// A request is tracked only when the feature is on for the restaurant, the token is a
// customer's or a guest's, and that user hasn't turned activity sharing off (§ Definitions,
// "Tracked request"). Anonymous, owner, staff, admin and rider requests never get here with a
// matching role (staff/rider tokens are signed with other secrets, so optionalAuthenticate
// leaves req.user unset for them).

const TRACKED_ROLES = new Set(['customer', 'guest']);
// Repeat views / checkout opens are folded per session + type (+ item) inside these windows.
const COALESCED = {
  restaurant_viewed: COALESCE.viewMs,
  item_viewed: COALESCE.viewMs,
  checkout_started: COALESCE.checkoutStartedMs,
  bill_viewed: COALESCE.viewMs,
};
// The QR menu app polls the bill while it is on screen, so a fixed window wrote one
// "Opened the bill" row a minute for as long as the guest kept it open. This window slides:
// one row per visit to the bill, a new one only after a minute away from it.
const SLIDING = new Set(['bill_viewed']);

const REQUEST_LABELS = { call_waiter: 'Called the waiter', water: 'Asked for water', bill: 'Asked for the bill' };
const PREF_CACHE_SECONDS = 60;
const LABEL_MAX = 120;
const LRU_MAX = 10_000;

const key = {
  pref: (userId) => `${REDIS_PREFIX}pref:${userId}`,
  search: (userId) => `${REDIS_PREFIX}search:${userId}`,
  coalesce: (sessionId, type, itemId) => `${REDIS_PREFIX}co:${sessionId}:${type}:${itemId ?? '-'}`,
  touch: (sessionId) => `${REDIS_PREFIX}touch:${sessionId}`,
};

// ─── Redis (optional) ──────────────────────────────────────────────────────

let redisOverride; // undefined → the real client; null → none; object → a test double

const liveRedis = () => {
  if (redisOverride !== undefined) return redisOverride;
  return redis?.status === 'ready' ? redis : null;
};

/** Tests only: a Redis double (get / set with EX + NX / del), `null` for none, `undefined` to restore. */
export const __setRedisForTests = (client) => {
  redisOverride = client;
};

// Without Redis, the coalescing windows live in this bounded in-process map (key → expiry ms).
// Map keeps insertion order, so the first key is the oldest; past LRU_MAX it is dropped.
const windows = new Map();

/**
 * Claims `k` for `ms` — true the first time inside the window, false while it is held.
 * With `slide`, every repeat inside the window pushes its end out again, so a stream of
 * repeats less than `ms` apart folds into the one event that opened it.
 */
const claimWindow = async (k, ms, { slide = false } = {}) => {
  const client = liveRedis();
  if (client) {
    try {
      const claimed = (await client.set(k, '1', 'EX', Math.ceil(ms / 1000), 'NX')) === 'OK';
      if (!claimed && slide) await client.set(k, '1', 'EX', Math.ceil(ms / 1000));
      return claimed;
    } catch (err) {
      logger.warn({ err: err.message }, 'live activity: coalesce key failed, using in-process window');
    }
  }
  const at = now().getTime();
  const heldUntil = windows.get(k);
  if (heldUntil !== undefined && heldUntil > at) {
    if (slide) windows.set(k, at + ms);
    return false;
  }
  windows.delete(k);
  windows.set(k, at + ms);
  if (windows.size > LRU_MAX) windows.delete(windows.keys().next().value);
  return true;
};

// ─── Consent ───────────────────────────────────────────────────────────────

/** True unless the user turned activity sharing off (missing = on). Cached 60 s in Redis. */
const isSharing = async (userId) => {
  const client = liveRedis();
  if (client) {
    try {
      const cached = await client.get(key.pref(userId));
      if (cached === '1' || cached === '0') return cached === '1';
    } catch {
      // fall through to the database
    }
  }
  const user = await User.findById(userId).select('preferences.shareActivity').lean();
  if (!user) return false;
  const sharing = user.preferences?.shareActivity !== false;
  if (client) {
    try {
      await client.set(key.pref(userId), sharing ? '1' : '0', 'EX', PREF_CACHE_SECONDS);
    } catch {
      // the cache is only a shortcut
    }
  }
  return sharing;
};

/** Drops the cached sharing preference — called whenever the customer changes it. */
export const forgetSharePreference = async (userId) => {
  try {
    await liveRedis()?.del(key.pref(userId));
  } catch (err) {
    logger.warn({ err: err.message, userId: String(userId) }, 'live activity: preference cache delete failed');
  }
};

/** The cheap, synchronous part of the gate: token role (and the switch, when no restaurant yet). */
const isTrackableUser = (req) => Boolean(req?.user?._id) && TRACKED_ROLES.has(req.user.role);

/**
 * Whether a hook should do any pre-reads for this request (e.g. the cart line before a
 * change). False with the feature off, so existing requests do no extra work.
 */
const wantsActivity = (req) => isLiveActivityEnabled() && isTrackableUser(req);

// ─── Text ──────────────────────────────────────────────────────────────────

/** Trimmed, control characters removed, whitespace collapsed, capped at `max`. */
export const sanitizeText = (value, max = TEXT_LIMITS.menuQueryMax) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
};

/** First word of the name, ≤20 chars; "Customer" without a name; "Guest" for guests. Never the phone. */
export const displayNameFor = (user) => {
  if (user.role === 'guest') return 'Guest';
  const first = sanitizeText(user.name ?? '', 200).split(' ')[0] ?? '';
  return first.slice(0, TEXT_LIMITS.displayNameMax) || 'Customer';
};

const clip = (text) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text);

/** The short, human line the owner sees for an event. */
export const labelFor = (type, data = {}) => {
  const item = data.itemName || 'an item';
  switch (type) {
    case 'restaurant_viewed':
      return 'Viewed menu';
    case 'menu_searched':
      return clip(`Searched "${data.query}"`);
    case 'item_viewed':
      return clip(`Viewed ${item}`);
    case 'cart_item_added':
      return clip(`Added ${item} ×${data.qty ?? 1}`);
    case 'cart_qty_changed':
      return clip(`Changed ${item} to ×${data.qty}`);
    case 'cart_item_removed':
      return clip(`Removed ${item}`);
    case 'cart_cleared':
      return 'Cleared cart';
    case 'checkout_started':
      return 'Started checkout';
    case 'checkout_left':
      return 'Left checkout';
    case 'went_idle':
      return 'Went idle';
    case 'cart_abandoned':
      return 'Left with items in cart';
    case 'offer_sent':
      return data.offerText ? clip(`Offer sent: ${data.offerText}`) : 'Offer sent';
    case 'offer_viewed':
      return 'Viewed offer';
    case 'offer_applied':
      return 'Applied offer';
    case 'order_placed':
      return 'Placed order';
    case 'waiter_called':
      return REQUEST_LABELS[data.requestType] ?? 'Asked for help';
    case 'bill_viewed':
      return 'Opened the bill';
    case 'bill_paid':
      return 'Paid the bill';
    default:
      return type;
  }
};

// ─── Cart snapshot ─────────────────────────────────────────────────────────

/**
 * The session's copy of the server cart: lines (≤50) and the total from the SAME bill the
 * endpoint returned — never recomputed. `cart` / `bill` are what the cart service handed back.
 */
export const cartSnapshot = (cart, bill, at) => ({
  items: (cart?.items ?? []).slice(0, TEXT_LIMITS.cartSnapshotMaxLines).map((line) => ({
    menuItemId: line.menuItemId,
    name: line.name,
    qty: line.qty,
    unitPricePaise: toPaise(line.unitPrice ?? 0),
  })),
  totalPaise: bill?.charges?.grandTotal ?? 0,
  updatedAt: at,
});

// ─── Sessions ──────────────────────────────────────────────────────────────

/**
 * One sweeper-style transition: a single conditional update on the `_id`, `status` and
 * `lastActivityAt` that were read (plus `extraFilter`), so two sweepers, overlapping ticks or a
 * customer event arriving in between can never double-transition or overwrite fresh activity.
 * The event is written only when this call made the change. `lastActivityAt` (and so the
 * session's `expiresAt`) is left alone — these are not customer activity.
 *
 * Owners are told (A6): straight away, or — with `batch` (a sweep tick) — once at the end.
 */
const transition = async (session, { extraFilter = {}, set = {}, event = null, at, batch = null }) => {
  const { modifiedCount } = await CustomerSession.updateOne(
    { _id: session._id, status: session.status, lastActivityAt: session.lastActivityAt, ...extraFilter },
    {
      $set: { ...set, ...(event ? { lastEvent: { type: event.type, label: event.label, at } } : {}) },
      ...(event ? { $inc: { eventCount: 1 } } : {}),
    }
  );
  if (modifiedCount !== 1) return false;
  const written = event
    ? (
        await ActivityEvent.create({
          sessionId: session._id,
          restaurantId: session.restaurantId,
          userId: session.userId,
          type: event.type,
          label: event.label,
          data: event.data ?? {},
          at,
        })
      ).toObject()
    : null;
  if (batch) {
    batch.session(session._id);
    if (written) batch.event(written);
  } else {
    await publishSessionChange(session._id, written, { restaurantId: session.restaurantId });
  }
  return true;
};

/**
 * Closes an open session by the timeout rule (A2's "new session after 30 min" and the
 * sweeper): items in the cart → `abandoned` plus a `cart_abandoned` event with the cart total,
 * a diner who ordered at their table → `converted`, otherwise `ended`. Resolves the new status, or null when the session changed since it was read.
 */
export const closeTimedOutSession = async (session, at = now(), batch = null) => {
  const abandoned = (session.cart?.items?.length ?? 0) > 0;
  // A diner who ordered at their table and whose bill was never marked paid here still bought.
  const ate = session.channel === 'dine_in' && Boolean(session.orderId);
  const status = abandoned ? 'abandoned' : ate ? 'converted' : 'ended';
  const done = await transition(session, {
    at,
    batch,
    set: sessionStatusFields(status),
    event: abandoned
      ? { type: 'cart_abandoned', label: labelFor('cart_abandoned'), data: { totalPaise: session.cart.totalPaise } }
      : null,
  });
  return done ? status : null;
};

/** `active` → `idle` with a `went_idle` event. True when this call made the change. */
export const idleSession = (session, at = now(), batch = null) =>
  session.status !== 'active'
    ? false
    : transition(session, {
        at,
        batch,
        set: sessionStatusFields('idle'),
        event: { type: 'went_idle', label: labelFor('went_idle') },
      });

/**
 * One `checkout_left` per checkout attempt: conditional on the `checkoutStartedAt` that was
 * read, which the same update clears — so it can only fire once until checkout starts again.
 */
export const markCheckoutLeft = (session, at = now(), batch = null) =>
  !session.checkoutStartedAt
    ? false
    : transition(session, {
        at,
        batch,
        extraFilter: { checkoutStartedAt: session.checkoutStartedAt },
        set: { checkoutLeftAt: at, checkoutStartedAt: null },
        event: { type: 'checkout_left', label: labelFor('checkout_left') },
      });

/**
 * An event the customer didn't cause (an owner sending an offer): it goes on the session's
 * timeline and `lastEvent`, but `lastActivityAt` — the customer's activity clock — is left
 * alone. `push` adds to arrays on the session (e.g. `{ offerIds: id }`). `data.offerText` only
 * shapes the label; it is not stored.
 */
export const appendSessionEvent = async (session, type, data = {}, { at = now(), push } = {}) => {
  const { offerText, ...stored } = data;
  const label = labelFor(type, { ...stored, offerText });
  await CustomerSession.updateOne(
    { _id: session._id },
    {
      $set: { lastEvent: { type, label, at } },
      $inc: { eventCount: 1 },
      ...(push ? { $push: push } : {}),
    }
  );
  const event = await ActivityEvent.create({
    sessionId: session._id,
    restaurantId: session.restaurantId,
    userId: session.userId,
    type,
    label,
    data: stored,
    at,
  });
  await publishSessionChange(session._id, event.toObject());
  return event.toObject();
};

/**
 * Personal offers past their end date close as `expired` — but never one with a redemption
 * in flight (`redemptionCount: 0`), so an order being placed with it keeps it. One
 * conditional update per offer (lapsed offers are few), so each closed one can be announced.
 * Returns how many were closed.
 */
export const expirePersonalOffers = async (at = now(), batch = null) => {
  const lapsed = { kind: 'personal', isOpen: true, endDate: { $lte: at }, redemptionCount: 0 };
  const candidates = await Discount.find(lapsed).select('_id').limit(SWEEP.batchSize).lean();
  let expired = 0;
  for (const { _id } of candidates) {
    const offer = await Discount.findOneAndUpdate(
      { _id, ...lapsed },
      { $set: { offerStatus: 'expired', isOpen: false, status: 'expired' } },
      { new: true, lean: true }
    );
    if (!offer) continue;
    expired += 1;
    batch?.offer(offer);
  }
  return expired;
};

/**
 * The filter every owner read (A4) and every emit (A6) starts from: this restaurant's sessions
 * minus those of customers who turned sharing off (`hiddenAt`, set on all their sessions).
 */
export const liveSessionScope = (restaurantId) => ({ restaurantId, hiddenAt: null });

const findOpenSession = (restaurantId, userId) =>
  CustomerSession.findOne({ restaurantId, userId, isOpen: true }).lean();

/** How long a session may be silent before it closes: much longer for a diner who has ordered. */
const closeAfterFor = (session) =>
  session.channel === 'dine_in' && session.orderId ? SESSION_TIMINGS.dineInCloseAfterMs : SESSION_TIMINGS.closeAfterMs;

/**
 * The table a request comes from: a yulo_menu diner's token names the restaurant + table it was
 * issued at (auth.service.js generateDinerToken). Null for any other request, or a token issued
 * at another restaurant.
 */
export const dineInOf = (req, restaurantId) => {
  const dineIn = req?.user?.dineIn;
  if (!dineIn || String(dineIn.restaurantId) !== String(restaurantId)) return null;
  return mongoose.isValidObjectId(dineIn.tableId) ? { tableId: String(dineIn.tableId) } : null;
};

const tableFields = async (restaurantId, dineIn) => {
  const table = await Table.findOne({ _id: dineIn.tableId, restaurantId }).select('identifier').lean();
  return table ? { channel: 'dine_in', table: { id: table._id, number: table.identifier ?? null } } : null;
};

/**
 * The cart a new session starts with: the customer's current server cart when it is for this
 * restaurant (they came back to a cart they filled earlier — I1 found the owner seeing "Empty
 * cart" until their next cart action), priced by the same bill every cart endpoint returns.
 * Undefined when there is none.
 */
const existingCartSnapshot = async (userId, restaurantId, at) => {
  const cart = await Cart.findOne({ userId }).select('restaurantId items._id').lean();
  if (!cart?.items?.length || String(cart.restaurantId) !== String(restaurantId)) return undefined;
  const { cart: priced, bill } = await cartService.getCart(userId);
  return cartSnapshot(priced, bill, at);
};

const openSession = async (user, restaurantId, at, dineIn = null) => {
  const isGuest = user.role === 'guest';
  const [pastOrderCount, cart, table] = await Promise.all([
    isGuest ? 0 : Order.countDocuments({ userId: user._id, restaurantId, status: 'delivered' }),
    // A diner's cart lives on their phone and arrives through the table cart sync.
    dineIn ? undefined : existingCartSnapshot(user._id, restaurantId, at),
    dineIn ? tableFields(restaurantId, dineIn) : null,
  ]);
  try {
    const created = await CustomerSession.create({
      restaurantId,
      userId: user._id,
      isGuest,
      displayName: displayNameFor(user),
      pastOrderCount,
      status: 'active',
      startedAt: at,
      lastActivityAt: at,
      ...(cart ? { cart } : {}),
      ...(table ?? {}),
    });
    return created.toObject();
  } catch (err) {
    // A concurrent request opened it first — use theirs.
    if (err?.code === 11000) return findOpenSession(restaurantId, user._id);
    throw err;
  }
};

/** The open session for restaurant + user, closing a timed-out one and opening a new one. */
const sessionFor = async (user, restaurantId, at, dineIn = null) => {
  let session = await findOpenSession(restaurantId, user._id);
  if (session && at - session.lastActivityAt >= closeAfterFor(session)) {
    await closeTimedOutSession(session, at);
    session = null;
  }
  return session ?? openSession(user, restaurantId, at, dineIn);
};

// ─── Search attribution ────────────────────────────────────────────────────

/**
 * Remembers a tracked customer's restaurant search for 10 minutes — `{ query, restaurantIds }`
 * — so opening one of those restaurants can say where the visit came from. Writes no event and
 * no session. Skipped without Redis.
 */
export const rememberSearch = (req, query, restaurantIds) =>
  track(async () => {
    if (!wantsActivity(req)) return null;
    const client = liveRedis();
    const text = sanitizeText(query);
    if (!client || !text) return null;
    if (!(await isSharing(req.user._id))) return null;
    const ids = (restaurantIds ?? []).slice(0, TEXT_LIMITS.searchAttributionMaxIds).map(String);
    await client.set(
      key.search(req.user._id),
      JSON.stringify({ query: text, restaurantIds: ids }),
      'EX',
      Math.ceil(SEARCH_ATTRIBUTION_MS / 1000)
    );
    return null;
  }, req);

const searchThatLedTo = async (userId, restaurantId) => {
  const client = liveRedis();
  if (!client) return null;
  try {
    const raw = await client.get(key.search(userId));
    if (!raw) return null;
    const { query, restaurantIds } = JSON.parse(raw);
    return Array.isArray(restaurantIds) && restaurantIds.includes(String(restaurantId))
      ? sanitizeText(query) || null
      : null;
  } catch {
    return null;
  }
};

// ─── Recording ─────────────────────────────────────────────────────────────

const inFlight = new Set();

// Runs `fn` detached from the request: never throws, logs ids only, tracked for tests.
const track = (fn, req, context = {}) => {
  const promise = (async () => {
    try {
      return await fn();
    } catch (err) {
      logger.warn(
        { err: err?.message, userId: req?.user?._id ? String(req.user._id) : undefined, ...context },
        'live activity: record failed'
      );
      return null;
    }
  })();
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise));
  return promise;
};

/** Tests only: waits for every record started so far (and any they start). */
export const __flushForTests = async () => {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
};

/** Tests only: forgets the in-process coalescing windows. */
export const __resetWindowsForTests = () => windows.clear();
/** Tests only: the coalescing claim itself, and how many in-process windows are held. */
export const __claimWindowForTests = (k, ms) => claimWindow(k, ms);
export const __windowSizeForTests = () => windows.size;

const recordNow = async (req, restaurantId, type, data) => {
  if (!restaurantId || !isLiveActivityEnabledFor(restaurantId) || !isTrackableUser(req)) return null;
  const user = req.user;
  if (!(await isSharing(user._id))) return null;

  restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
  const at = now();
  const dineIn = dineInOf(req, restaurantId);
  const session = await sessionFor(user, restaurantId, at, dineIn);
  if (!session) return null;
  const atTable = session.channel === 'dine_in';

  const coalesceMs = COALESCED[type];
  if (coalesceMs && !(await claimWindow(key.coalesce(session._id, type, data.menuItemId), coalesceMs, { slide: SLIDING.has(type) }))) {
    // Folded into the earlier event; still counts as activity, at most every 30 s.
    if (await claimWindow(key.touch(session._id), COALESCE.lastActivityRefreshMs)) {
      const { modifiedCount } = await CustomerSession.updateOne(
        { _id: session._id, isOpen: true },
        { $set: { lastActivityAt: at, expiresAt: sessionExpiresAt(at), ...sessionStatusFields('active') } }
      );
      if (modifiedCount === 1) await publishSessions([session._id], { restaurantId: session.restaurantId });
    }
    return null;
  }

  const { cart, bill, ...eventData } = data;
  const label = labelFor(type, eventData);
  const set = {
    lastActivityAt: at,
    expiresAt: sessionExpiresAt(at),
    lastEvent: { type, label, at },
    // A diner orders round after round at their table: ordering doesn't end their visit — the
    // bill being paid does (closeDineInTable).
    ...sessionStatusFields(type === 'order_placed' && !atTable ? 'converted' : 'active'),
  };
  // A session opened in the app, then the same guest scanned a table (or moved table).
  if (dineIn && String(session.table?.id ?? '') !== dineIn.tableId) {
    Object.assign(set, (await tableFields(restaurantId, dineIn)) ?? {});
  }
  if (cart !== undefined) set.cart = cartSnapshot(cart, bill, at);
  if (type === 'checkout_started') {
    if (!session.checkoutStartedAt) set.checkoutStartedAt = at;
    set.checkoutLeftAt = null;
  }
  if (type === 'order_placed') set.orderId = eventData.orderId;
  if (type === 'restaurant_viewed' && session.cameFromSearch == null) {
    const query = await searchThatLedTo(user._id, restaurantId);
    if (query) set.cameFromSearch = query;
  }

  // One update per event; only while still open — a session closed meanwhile is never reopened.
  const updated = await CustomerSession.findOneAndUpdate(
    { _id: session._id, isOpen: true },
    { $set: set, $inc: { eventCount: 1 } },
    { new: true, lean: true }
  );
  if (!updated) return null;

  const event = await ActivityEvent.create({
    sessionId: session._id,
    restaurantId,
    userId: user._id,
    type,
    label,
    data: eventData,
    at,
  });
  // Owners watching this restaurant see the event and the updated row (A6).
  await publishSessionChange(updated._id, event.toObject(), { restaurantId: updated.restaurantId });
  return { session: updated, event: event.toObject() };
};

/**
 * Records one customer action on `restaurantId`'s live session. Call it after the response is
 * sent, as `void record(...)`. `data` holds the event's small fields (menuItemId, itemName, qty,
 * deltaQty, totalPaise, query, orderId) plus, for cart events, `cart` + `bill` from the
 * endpoint's own response for the session's cart snapshot. Resolves `{ session, event }`, or
 * null when nothing was recorded (not tracked, coalesced, or an error — never rejects).
 */
export const record = (req, restaurantId, type, data = {}) =>
  track(() => recordNow(req, restaurantId, type, data), req, {
    restaurantId: restaurantId ? String(restaurantId) : undefined,
    type,
  });

// ─── Dine-in (yulo_menu) ───────────────────────────────────────────────────

/**
 * A diner's cart, as their phone holds it now (yulo_menu keeps the cart on the phone until an
 * order is placed). `lines` are already priced by the server from the menu —
 * `[{ menuItemId, name, qty, unitPrice }]` in rupees — never the phone's prices. Compared with
 * the session's last snapshot, each difference is recorded as its own cart event (added /
 * quantity changed / removed, or one `cart_cleared` when everything went), carrying the new
 * snapshot. Nothing changed → nothing recorded. Same rules as record(): never rejects.
 */
export const recordDineInCart = (req, restaurantId, lines) =>
  track(
    async () => {
      if (!restaurantId || !isLiveActivityEnabledFor(restaurantId) || !isTrackableUser(req)) return null;
      if (!dineInOf(req, restaurantId)) return null;
      const open = await findOpenSession(new mongoose.Types.ObjectId(String(restaurantId)), req.user._id);
      const before = new Map((open?.cart?.items ?? []).map((line) => [String(line.menuItemId), line]));
      const after = new Map(lines.map((line) => [String(line.menuItemId), line]));
      const totalPaise = lines.reduce((sum, line) => sum + toPaise(line.unitPrice) * line.qty, 0);
      const snapshot = { cart: { items: lines }, bill: { charges: { grandTotal: totalPaise } } };

      const changes = [];
      if (lines.length === 0 && before.size > 1) {
        changes.push(['cart_cleared', {}]);
      } else {
        for (const [id, line] of after) {
          const was = before.get(id);
          if (!was) changes.push(['cart_item_added', { menuItemId: id, itemName: line.name, qty: line.qty, deltaQty: line.qty }]);
          else if (was.qty !== line.qty) {
            changes.push(['cart_qty_changed', { menuItemId: id, itemName: line.name, qty: line.qty, deltaQty: line.qty - was.qty }]);
          }
        }
        for (const [id, was] of before) {
          if (!after.has(id)) changes.push(['cart_item_removed', { menuItemId: id, itemName: was.name, qty: 0, deltaQty: -was.qty }]);
        }
      }
      let last = null;
      for (const [type, data] of changes) last = await recordNow(req, restaurantId, type, { ...data, totalPaise, ...snapshot });
      return last;
    },
    req,
    { restaurantId: String(restaurantId), type: 'dine_in_cart' }
  );

/**
 * A table's bill was paid: the visits of everyone who scanned that table end — `converted`
 * (with a `bill_paid` event) for diners who ordered, `ended` for those who only looked.
 * Called by billing.service.js markPaid; never throws.
 */
export const closeDineInTable = async ({ restaurantId, tableId }, at = now()) => {
  try {
    if (!tableId || !isLiveActivityEnabledFor(restaurantId)) return 0;
    const sessions = await CustomerSession.find({ channel: 'dine_in', 'table.id': tableId, restaurantId, isOpen: true })
      .select(SWEEP_FIELDS)
      .lean();
    let closed = 0;
    for (const session of sessions) {
      const ordered = Boolean(session.orderId);
      const done = await transition(session, {
        at,
        set: { ...sessionStatusFields(ordered ? 'converted' : 'ended'), checkoutStartedAt: null },
        event: ordered ? { type: 'bill_paid', label: labelFor('bill_paid') } : null,
      });
      if (done) closed += 1;
    }
    return closed;
  } catch (err) {
    logger.warn({ err: err.message, tableId: String(tableId) }, 'live activity: closing a paid table failed');
    return 0;
  }
};

// ─── Sweeper ───────────────────────────────────────────────────────────────

// Only what the transitions need from each session.
const SWEEP_FIELDS = '_id restaurantId userId status lastActivityAt cart checkoutStartedAt channel orderId';

/**
 * Moves sessions along on their own, oldest first, at most SWEEP.batchSize per call:
 *   1. open, last activity ≥ 30 min ago → `abandoned` (cart items) or `ended`
 *   2. `active`, last activity ≥ 5 min ago → `idle`
 *   3. open, checkout started ≥ 10 min ago with no order → one `checkout_left`
 * Every write is conditional on what was read (see `transition`), so it is safe to run from
 * two processes or overlapping ticks. Then closes lapsed personal offers. Returns
 * `{ idled, abandoned, ended, checkoutLeft, expired, scanned }`.
 */
export const sweepSessions = async (at = now()) => {
  const summary = { idled: 0, abandoned: 0, ended: 0, converted: 0, checkoutLeft: 0, expired: 0, scanned: 0 };
  // Owners hear about this tick once, at the end: one session_updated per changed session.
  const batch = createBatch();
  const before = (ms) => new Date(at.getTime() - ms);
  const budget = () => SWEEP.batchSize - summary.scanned;
  const fetch = async (filter, sort) => {
    if (budget() <= 0) return [];
    const rows = await CustomerSession.find(filter).sort(sort).limit(budget()).select(SWEEP_FIELDS).lean();
    summary.scanned += rows.length;
    return rows;
  };

  // Uses { status, lastActivityAt } (models/CustomerSession.js). A diner who has ordered at
  // their table is eating, not gone: they get the much longer dine-in window (closeAfterFor).
  const eating = { channel: 'dine_in', orderId: { $ne: null } };
  for (const filter of [
    { $nor: [eating], lastActivityAt: { $lte: before(SESSION_TIMINGS.closeAfterMs) } },
    { ...eating, lastActivityAt: { $lte: before(SESSION_TIMINGS.dineInCloseAfterMs) } },
  ]) {
    for (const session of await fetch({ status: { $in: OPEN_SESSION_STATUSES }, ...filter }, { lastActivityAt: 1 })) {
      const closed = await closeTimedOutSession(session, at, batch);
      if (closed) summary[closed] += 1;
    }
  }

  for (const session of await fetch(
    {
      status: 'active',
      lastActivityAt: { $lte: before(SESSION_TIMINGS.idleAfterMs) },
    },
    { lastActivityAt: 1 }
  )) {
    if (await idleSession(session, at, batch)) summary.idled += 1;
  }

  // Uses the partial { checkoutStartedAt } index over open sessions.
  for (const session of await fetch(
    { isOpen: true, checkoutStartedAt: { $lte: before(SESSION_TIMINGS.checkoutLeftAfterMs) } },
    { checkoutStartedAt: 1 }
  )) {
    if (await markCheckoutLeft(session, at, batch)) summary.checkoutLeft += 1;
  }

  summary.expired = await expirePersonalOffers(at, batch);
  await batch.flush();
  return summary;
};

let sweeping = false;

/**
 * The 60 s tick from socket.js: nothing with the feature off, and never two at once in this
 * process (a slow tick is skipped over, not stacked). Never throws.
 */
export const runSessionSweep = async () => {
  if (!isLiveActivityEnabled() || sweeping) return null;
  sweeping = true;
  try {
    const summary = await sweepSessions();
    const changed = summary.idled + summary.abandoned + summary.ended + summary.converted + summary.checkoutLeft + summary.expired;
    if (changed > 0) logger.debug({ ...summary }, 'live activity: sessions swept');
    return summary;
  } catch (err) {
    logger.warn({ err: err.message }, 'live activity: session sweep failed');
    return null;
  } finally {
    sweeping = false;
  }
};
