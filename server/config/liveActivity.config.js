// Live customer activity + personalized offers — every switch, number and enum the feature
// uses, in one place. Models, services and tests import from here; nothing else hard-codes a
// timing, a limit or a status name. The rules behind these numbers are in
// yulo_backend/LIVE_ACTIVITY_IMPLEMENTATION_PROMPTS.md (§ Rules).

import { env } from './env.js';

// ─── Enums ─────────────────────────────────────────────────────────────────

export const SESSION_STATUSES = ['active', 'idle', 'abandoned', 'ended', 'converted'];
// A session in one of these is "open": at most one per restaurant + customer (partial unique
// index on CustomerSession). The rest are closed and never reopen.
export const OPEN_SESSION_STATUSES = ['active', 'idle'];
export const isOpenSessionStatus = (status) => OPEN_SESSION_STATUSES.includes(status);

export const EVENT_TYPES = [
  'restaurant_viewed',
  'menu_searched',
  'item_viewed',
  'cart_item_added',
  'cart_qty_changed',
  'cart_item_removed',
  'cart_cleared',
  'checkout_started',
  'checkout_left',
  'went_idle',
  'cart_abandoned',
  'offer_sent',
  'offer_viewed',
  'offer_applied',
  'order_placed',
];

export const OFFER_STATUSES = ['sent', 'delivered', 'viewed', 'applied', 'redeemed', 'expired', 'revoked'];
// An offer in one of these is "open" (Discount.isOpen): at most one per restaurant + customer.
export const OPEN_OFFER_STATUSES = ['sent', 'delivered', 'viewed', 'applied'];

// ─── Session timings ───────────────────────────────────────────────────────

const MINUTE = 60 * 1000;

/**
 * All timings are measured from a session's `lastActivityAt`. `closeAfterMs` is both when an
 * idle session becomes abandoned/ended and when the next event opens a new session instead.
 * `testTimings` (LIVE_ACTIVITY_TEST_TIMINGS) shortens them for walking timeouts by hand; it is
 * refused in production here as well as at startup (config/env.js).
 */
export const resolveSessionTimings = ({ testTimings = false, nodeEnv = 'development' } = {}) => {
  if (testTimings && nodeEnv === 'production') {
    throw new Error('LIVE_ACTIVITY_TEST_TIMINGS is a local-only setting and is refused in production');
  }
  return testTimings
    ? { idleAfterMs: 30 * 1000, closeAfterMs: 2 * MINUTE, checkoutLeftAfterMs: 1 * MINUTE }
    : { idleAfterMs: 5 * MINUTE, closeAfterMs: 30 * MINUTE, checkoutLeftAfterMs: 10 * MINUTE };
};

export const SESSION_TIMINGS = Object.freeze(
  resolveSessionTimings({ testTimings: env.LIVE_ACTIVITY_TEST_TIMINGS, nodeEnv: env.NODE_ENV })
);

// Repeat views and checkout opens inside these windows are folded into one event.
export const COALESCE = Object.freeze({
  viewMs: 60 * 1000,
  checkoutStartedMs: 60 * 1000,
  lastActivityRefreshMs: 30 * 1000,
});

// A global search counts toward a restaurant only if the customer opens it within this window.
export const SEARCH_ATTRIBUTION_MS = 10 * MINUTE;

// ─── Offer guardrails (rupees, as stored on Discount) ──────────────────────

export const OFFER_LIMITS = Object.freeze({
  maxOpenPerCustomer: 1,
  maxPerCustomerPerDay: 3, // IST calendar day; revoked and expired offers count
  percentageMin: 1,
  percentageMax: 50,
  flatMinRupees: 1,
  flatMaxRupees: 500,
  maxDiscountMinRupees: 1,
  maxDiscountMaxRupees: 500,
  expiryMinMinutes: 10,
  expiryMaxMinutes: 24 * 60,
  titleMaxLength: 40,
  applicableItemsMax: 20,
});

// ─── Retention, sweeping, paging, rate limits, text caps ───────────────────

export const RETENTION = Object.freeze({ eventDays: 30, sessionDays: 90 });

export const SWEEP = Object.freeze({ intervalMs: 60 * 1000, batchSize: 500 });

export const LIST_LIMITS = Object.freeze({
  sessionsDefault: 30,
  sessionsMax: 50,
  eventsDefault: 50,
  eventsMax: 100,
  offersMax: 50,
  offersRangeMaxDays: 90,
});

export const RATE_LIMITS = Object.freeze({ offerCreatePerMinutePerRestaurant: 20 });

export const TEXT_LIMITS = Object.freeze({
  menuQueryMax: 60,
  displayNameMax: 20,
  cartSnapshotMaxLines: 50,
  searchAttributionMaxIds: 50,
});

// Every Redis key this feature writes starts with this. NOT `live:` — that prefix already
// holds rider presence (`live:active_partners`), restaurant presence and the old Live Monitor
// stats, and a `live:*` cleanup would break rider dispatch.
export const REDIS_PREFIX = 'liveact:';

// ─── Switch + per-restaurant access ────────────────────────────────────────
//
// Two levels: LIVE_ACTIVITY_ENABLED is the server-wide switch, and a super admin turns the
// feature on per restaurant (Restaurant.liveActivityEnabled, from the store page —
// services/liveActivityAccess.service.js). The restaurants that are on are held here as a set
// of ids, so the check on every request is synchronous and never touches the database: the
// service loads the set at boot, updates it on a toggle, and re-reads it on a timer so every
// instance catches up with a toggle made on another.

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Splits a comma-separated id list into valid ids and the entries that were ignored. */
export const parseRestaurantAllowList = (raw = '') => {
  const ids = new Set();
  const invalid = [];
  for (const part of String(raw).split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (OBJECT_ID.test(id)) ids.add(id.toLowerCase());
    else invalid.push(id);
  }
  return { ids, invalid };
};

const fromEnv = () => ({ enabled: env.LIVE_ACTIVITY_ENABLED, everyRestaurant: false, restaurantIds: new Set() });

let settings = fromEnv();

/** The feature switch (LIVE_ACTIVITY_ENABLED). */
export const isLiveActivityEnabled = () => settings.enabled;

/** On for this restaurant: the switch is on AND a super admin turned it on for the restaurant. */
export const isLiveActivityEnabledFor = (restaurantId) => {
  if (!settings.enabled) return false;
  if (settings.everyRestaurant) return true;
  return restaurantId != null && settings.restaurantIds.has(String(restaurantId).toLowerCase());
};

/** Replaces the set of restaurants the feature is on for (the database's view). */
export const setLiveActivityRestaurants = (ids) => {
  settings = { ...settings, restaurantIds: new Set([...ids].map((id) => String(id).toLowerCase())) };
};

/** One restaurant turned on or off (applied on this instance at once; others on their next read). */
export const markLiveActivityRestaurant = (restaurantId, on) => {
  const restaurantIds = new Set(settings.restaurantIds);
  if (on) restaurantIds.add(String(restaurantId).toLowerCase());
  else restaurantIds.delete(String(restaurantId).toLowerCase());
  settings = { ...settings, restaurantIds };
};

/**
 * Tests only. `{ enabled, restaurantIds }`: `restaurantIds` omitted or '' means every
 * restaurant (for tests that aren't about access), 'id1,id2' means just those, and
 * `{ enabled, perRestaurant: true }` uses the real per-restaurant set (setLiveActivityRestaurants
 * / the access service). `null` goes back to the environment's switch with an empty set.
 */
export const __setLiveActivityForTests = (override) => {
  if (override == null) {
    settings = fromEnv();
    return;
  }
  if (override.perRestaurant) {
    settings = { enabled: Boolean(override.enabled), everyRestaurant: false, restaurantIds: settings.restaurantIds };
    return;
  }
  const { ids } = parseRestaurantAllowList(override.restaurantIds ?? '');
  settings = { enabled: Boolean(override.enabled), everyRestaurant: ids.size === 0, restaurantIds: ids };
};
