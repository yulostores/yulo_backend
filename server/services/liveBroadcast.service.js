import CustomerSession from '../models/CustomerSession.js';
import Restaurant from '../models/Restaurant.js';
import MenuItem from '../models/MenuItem.js';
import { emitToOwners, emitToUser, ownersListening } from './liveEmit.service.js';
import { eligibilityFor, eventView } from './personalOffer.service.js';
import { toSessionRow } from './liveSession.serializer.js';
import { now } from '../utils/clock.js';
import logger from '../utils/logger.js';

// What the owner's dashboard and the customer's app are told, built from the same shapes the
// HTTP API returns (toSessionRow, the event view, the offer fields) — never a raw document.
// Sent through liveEmit.service.js (rooms, the feature switch, the PII guard). Every function
// here swallows its own errors: a failed push never fails the action that caused it.

const iso = (date) => (date ? new Date(date).toISOString() : null);

const safely = (what, fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    logger.warn({ err: err.message }, `live activity: ${what} broadcast failed`);
    return null;
  }
};

/** `activity_event` for one kept (non-coalesced) event. */
export const publishEvent = safely('activity_event', async (event) => {
  emitToOwners(event.restaurantId, 'activity_event', { sessionId: String(event.sessionId), ...eventView(event) });
});

/**
 * One `session_updated` per session (deduplicated), exactly toSessionRow with eligibility,
 * for owners who are watching. Hidden (opted-out) sessions are never sent. A few queries per
 * restaurant, whatever the number of sessions — and none at all when `restaurantId` is given
 * and no owner of it is connected (the common case for a customer's request).
 */
export const publishSessions = safely('session_updated', async (sessionIds, { restaurantId } = {}) => {
  if (restaurantId && !ownersListening(String(restaurantId))) return;
  const ids = [...new Set([...sessionIds].map(String))];
  if (ids.length === 0) return;
  const sessions = await CustomerSession.find({ _id: { $in: ids }, hiddenAt: null }).lean();
  const byRestaurant = new Map();
  for (const session of sessions) {
    const key = String(session.restaurantId);
    if (!ownersListening(key)) continue;
    if (!byRestaurant.has(key)) byRestaurant.set(key, []);
    byRestaurant.get(key).push(session);
  }
  const at = now();
  for (const [restaurantId, rows] of byRestaurant) {
    const verdict = await eligibilityFor(restaurantId, rows, at);
    for (const session of rows) {
      emitToOwners(restaurantId, 'session_updated', toSessionRow(session, { offerEligibility: verdict(session) }));
    }
  }
});

/**
 * A session changed and (optionally) gained an event: the event, then the row. Pass the
 * session's `restaurantId` when known, so nothing is read for a restaurant nobody is watching.
 */
export const publishSessionChange = async (sessionId, event = null, { restaurantId } = {}) => {
  if (event) await publishEvent(event);
  await publishSessions([sessionId], { restaurantId: restaurantId ?? event?.restaurantId });
};

/** The customer turned sharing off: each of their sessions disappears from its dashboard. */
export const publishSessionsRemoved = safely('session_removed', async (sessions) => {
  for (const session of sessions) {
    emitToOwners(session.restaurantId, 'session_removed', { sessionId: String(session._id) });
  }
});

/**
 * `offer_updated` to the restaurant's owners — and, with `toCustomer`, to the customer — after
 * an offer's status changed. `offer` is the offer as it now is.
 */
export const publishOffer = safely('offer_updated', async (offer, { toCustomer = false, at = now() } = {}) => {
  const payload = {
    offerId: String(offer._id),
    sessionId: offer.sessionId ? String(offer.sessionId) : null,
    offerStatus: offer.offerStatus,
    at: iso(at),
    ...(offer.orderId ? { orderId: String(offer.orderId) } : {}),
  };
  emitToOwners(offer.restaurantId, 'offer_updated', payload);
  if (toCustomer) {
    const { sessionId, ...forCustomer } = payload;
    emitToUser(offer.targetUserId, 'offer_updated', forCustomer, { restaurantId: offer.restaurantId });
  }
});

/** `offer_received` to the customer the offer was just sent to. */
export const publishOfferReceived = safely('offer_received', async (offer) => {
  const [restaurant, items] = await Promise.all([
    Restaurant.findById(offer.restaurantId).select('name').lean(),
    offer.applicableItems?.length
      ? MenuItem.find({ _id: { $in: offer.applicableItems } }).select('name').lean()
      : [],
  ]);
  emitToUser(
    offer.targetUserId,
    'offer_received',
    {
      offerId: String(offer._id),
      restaurant: { id: String(offer.restaurantId), name: restaurant?.name ?? null },
      title: offer.offerName,
      type: offer.type,
      percentage: offer.percentage ?? null,
      flatAmount: offer.flatAmount ?? null,
      maxDiscountAmount: offer.maxDiscountAmount ?? null,
      minimumOrderValue: offer.minimumOrderValue ?? 0,
      applicableItems: items.map((item) => item.name),
      endDate: iso(offer.endDate),
    },
    { restaurantId: offer.restaurantId }
  );
});

/**
 * Collects a sweep tick's changes so each session gets one `session_updated` however many
 * transitions it went through, and every event/offer is sent once, after the tick.
 */
export const createBatch = () => {
  const sessionIds = new Set();
  const events = [];
  const offers = [];
  return {
    session: (id) => sessionIds.add(String(id)),
    event: (event) => events.push(event),
    offer: (offer) => offers.push(offer),
    flush: async () => {
      for (const event of events) await publishEvent(event);
      for (const offer of offers) {
        await publishOffer(offer, { toCustomer: true });
        if (offer.sessionId) sessionIds.add(String(offer.sessionId));
      }
      await publishSessions(sessionIds);
    },
  };
};
