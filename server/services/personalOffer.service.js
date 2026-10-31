import mongoose from 'mongoose';
import Discount from '../models/Discount.js';
import CustomerSession from '../models/CustomerSession.js';
import ActivityEvent from '../models/ActivityEvent.js';
import MenuItem from '../models/MenuItem.js';
import Cart from '../models/Cart.js';
import Order from '../models/Order.js';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import { LIST_LIMITS, OFFER_LIMITS, isLiveActivityEnabledFor } from '../config/liveActivity.config.js';
import { appendSessionEvent, liveSessionScope } from './activity.service.js';
import { personalOfferSavingPaise } from './discount.service.js';
import { toSessionRow } from './liveSession.serializer.js';
import { publishOffer, publishOfferReceived, publishSessions } from './liveBroadcast.service.js';
import { ApiError } from '../utils/ApiError.js';
import { now } from '../utils/clock.js';
import { toPaise } from '../utils/money.js';
import { dayBounds } from '../utils/week.js';

// Personal offers and the owner's live dashboard reads (A4). One owner-sent, capped,
// short-lived, restaurant-funded offer for one signed-in customer, stored as a `Discount` with
// `kind: 'personal'`. Every guardrail (§ Rules) is enforced here, server side; applying and
// redeeming are A5. Every session read starts from liveSessionScope (hidden = opted out).

const { ObjectId } = mongoose.Types;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const oid = (id) => new ObjectId(String(id));
const isObjectId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const iso = (date) => (date ? new Date(date).toISOString() : null);

// Reasons a session can't receive an offer, in the priority the dashboard shows them.
export const NOT_ELIGIBLE = Object.freeze({
  GUEST: 'GUEST',
  OPTED_OUT: 'OPTED_OUT',
  OFFER_OPEN: 'OFFER_OPEN',
  DAILY_LIMIT: 'DAILY_LIMIT',
  SESSION_CLOSED: 'SESSION_CLOSED',
});

// Sessions the owner may list (decided 27 Oct 2026: no "Recent" view of ended / converted).
export const LISTABLE_SESSION_STATUSES = ['active', 'idle', 'abandoned'];

// ─── Saving maths (shared with A5's apply / re-validation) ─────────────────

/**
 * What `offer` would take off `cart`, in paise — the owner's preview, by the same maths the
 * cart and checkout apply (discount.service.js personalOfferSavingPaise). `cart` is the
 * customer's server cart (lean Cart: restaurantId, items[{ menuItemId, unitPrice, qty }]).
 * `issue` (only when the saving is 0 for a reason): NO_CART, OFFER_NOT_APPLICABLE,
 * DISCOUNT_MIN_VALUE.
 */
export const offerSaving = (offer, cart) => {
  if (!cart?.items?.length || String(cart.restaurantId) !== String(offer.restaurantId)) {
    return { wouldSavePaise: 0, cartTotalPaise: 0, eligibleSubtotalPaise: 0, issue: 'NO_CART' };
  }
  const lines = cartLines(cart.items);
  const cartTotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const { eligiblePaise, savingPaise } = personalOfferSavingPaise(offer, lines);
  const result = { wouldSavePaise: 0, cartTotalPaise, eligibleSubtotalPaise: eligiblePaise };
  if (eligiblePaise === 0) return { ...result, issue: 'OFFER_NOT_APPLICABLE' };
  if (cartTotalPaise < toPaise(offer.minimumOrderValue ?? 0)) return { ...result, issue: 'DISCOUNT_MIN_VALUE' };
  return { ...result, wouldSavePaise: savingPaise };
};

/** Cart lines (unitPrice in rupees × qty) as the paise lines the saving maths takes. */
export const cartLines = (items) =>
  items.map((line) => ({ menuItemId: line.menuItemId, amountPaise: toPaise(line.unitPrice) * line.qty }));

/** "10% off up to ₹100" / "₹50 off" — for labels. */
export const offerText = (offer) =>
  offer.type === 'percentage'
    ? `${offer.percentage}% off up to ₹${offer.maxDiscountAmount}`
    : `₹${offer.flatAmount} off`;

// ─── Views ─────────────────────────────────────────────────────────────────

/** A personal offer as the owner sees it — picked field by field. */
export const toOfferView = (offer) => ({
  id: String(offer._id),
  title: offer.offerName,
  type: offer.type,
  percentage: offer.percentage ?? null,
  flatAmount: offer.flatAmount ?? null,
  maxDiscountAmount: offer.maxDiscountAmount ?? null,
  minimumOrderValue: offer.minimumOrderValue ?? 0,
  applicableItems: (offer.applicableItems ?? []).map(String),
  status: offer.offerStatus,
  sentAt: iso(offer.createdAt),
  expiresAt: iso(offer.endDate),
  deliveredAt: iso(offer.deliveredAt),
  viewedAt: iso(offer.viewedAt),
  appliedAt: iso(offer.appliedAt),
  redeemedAt: iso(offer.redeemedAt),
  revokedAt: iso(offer.revokedAt),
  redemptionCount: offer.redemptionCount ?? 0,
  orderId: offer.orderId ? String(offer.orderId) : null,
});

export const eventView = (event) => ({
  id: String(event._id),
  type: event.type,
  label: event.label,
  at: iso(event.at),
  data: {
    menuItemId: event.data?.menuItemId ? String(event.data.menuItemId) : null,
    itemName: event.data?.itemName ?? null,
    qty: event.data?.qty ?? null,
    deltaQty: event.data?.deltaQty ?? null,
    totalPaise: event.data?.totalPaise ?? null,
    query: event.data?.query ?? null,
    offerId: event.data?.offerId ? String(event.data.offerId) : null,
    orderId: event.data?.orderId ? String(event.data.orderId) : null,
  },
});

// ─── Eligibility (bulk) ────────────────────────────────────────────────────

/** Today's offers count only from this IST day's midnight. */
const istDay = (at) => dayBounds(at);

/**
 * Who on `sessions` can be sent an offer: three queries for any number of sessions (opted-out
 * users, open offers, today's counts) — never one per row. Returns `session → { eligible,
 * reason }`, reasons in the order of NOT_ELIGIBLE.
 */
export const eligibilityFor = async (restaurantId, sessions, at) => {
  const userIds = [...new Set(sessions.filter((s) => !s.isGuest).map((s) => String(s.userId)))].map(oid);
  let optedOut = new Set();
  let open = new Set();
  let today = new Map();
  if (userIds.length > 0) {
    const { start, end } = istDay(at);
    const [optedOutRows, openRows, todayRows] = await Promise.all([
      User.find({ _id: { $in: userIds }, 'preferences.shareActivity': false }).select('_id').lean(),
      Discount.find({ restaurantId, targetUserId: { $in: userIds }, isOpen: true }).select('targetUserId').lean(),
      Discount.aggregate([
        {
          $match: {
            restaurantId: oid(restaurantId),
            kind: 'personal',
            targetUserId: { $in: userIds },
            createdAt: { $gte: start, $lte: end },
          },
        },
        { $group: { _id: '$targetUserId', n: { $sum: 1 } } },
      ]),
    ]);
    optedOut = new Set(optedOutRows.map((u) => String(u._id)));
    open = new Set(openRows.map((d) => String(d.targetUserId)));
    today = new Map(todayRows.map((r) => [String(r._id), r.n]));
  }
  return (session) => {
    const user = String(session.userId);
    const reason = session.isGuest
      ? NOT_ELIGIBLE.GUEST
      : optedOut.has(user)
        ? NOT_ELIGIBLE.OPTED_OUT
        : open.has(user)
          ? NOT_ELIGIBLE.OFFER_OPEN
          : (today.get(user) ?? 0) >= OFFER_LIMITS.maxPerCustomerPerDay
            ? NOT_ELIGIBLE.DAILY_LIMIT
            : !session.isOpen
              ? NOT_ELIGIBLE.SESSION_CLOSED
              : null;
    return { eligible: reason === null, reason };
  };
};

// ─── Sessions ──────────────────────────────────────────────────────────────

const findSession = async (restaurantId, sessionId) => {
  if (!isObjectId(String(sessionId))) return null;
  return CustomerSession.findOne({ _id: sessionId, ...liveSessionScope(oid(restaurantId)) }).lean();
};

const sessionNotFound = () => new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found');

/**
 * The dashboard list: newest activity first, eligibility for the page in bulk, and the header
 * strip `summary`. A constant number of queries whatever the page size.
 */
export const listSessions = async (restaurantId, { statuses = ['active', 'idle', 'abandoned'], limit = LIST_LIMITS.sessionsDefault } = {}, at = now()) => {
  const scope = liveSessionScope(oid(restaurantId));
  const hourAgo = new Date(at.getTime() - 60 * MINUTE_MS);
  const hasCart = { $gt: [{ $size: { $ifNull: ['$cart.items', []] } }, 0] };

  const [sessions, [summary]] = await Promise.all([
    CustomerSession.find({ ...scope, status: { $in: statuses } }).sort({ lastActivityAt: -1, _id: -1 }).limit(limit).lean(),
    CustomerSession.aggregate([
      // Abandonment is stamped on lastEvent (cart_abandoned) when the session closes.
      { $match: { ...scope, $or: [{ isOpen: true }, { status: 'abandoned', 'lastEvent.at': { $gte: hourAgo } }] } },
      {
        $group: {
          _id: null,
          live: { $sum: { $cond: ['$isOpen', 1, 0] } },
          cartsInProgress: { $sum: { $cond: [{ $and: ['$isOpen', hasCart] }, 1, 0] } },
          cartsTotalPaise: { $sum: { $cond: [{ $and: ['$isOpen', hasCart] }, '$cart.totalPaise', 0] } },
          abandonedLastHour: { $sum: { $cond: [{ $eq: ['$status', 'abandoned'] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const verdict = await eligibilityFor(restaurantId, sessions, at);
  return {
    sessions: sessions.map((s) => toSessionRow(s, { offerEligibility: verdict(s) })),
    summary: {
      live: summary?.live ?? 0,
      cartsInProgress: summary?.cartsInProgress ?? 0,
      cartsTotalPaise: summary?.cartsTotalPaise ?? 0,
      abandonedLastHour: summary?.abandonedLastHour ?? 0,
    },
  };
};

/** One session: the row header, the full cart snapshot and the offers sent in it. */
export const getSession = async (restaurantId, sessionId, at = now()) => {
  const session = await findSession(restaurantId, sessionId);
  if (!session) throw sessionNotFound();
  const [verdict, offers] = await Promise.all([
    eligibilityFor(restaurantId, [session], at),
    Discount.find({ restaurantId, sessionId: session._id, kind: 'personal' }).sort({ createdAt: -1 }).lean(),
  ]);
  return {
    session: toSessionRow(session, { offerEligibility: verdict(session) }),
    cart: {
      items: (session.cart?.items ?? []).map((line) => ({
        menuItemId: String(line.menuItemId),
        name: line.name,
        qty: line.qty,
        unitPricePaise: line.unitPricePaise,
      })),
      totalPaise: session.cart?.totalPaise ?? 0,
      updatedAt: iso(session.cart?.updatedAt),
    },
    offers: offers.map(toOfferView),
  };
};

// `nextBefore` cursor: "<at ms>_<event id>" — ties on `at` are broken by _id.
const parseCursor = (before) => {
  if (before == null || before === '') return null;
  const match = /^(\d{1,15})_([a-f\d]{24})$/i.exec(String(before));
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cursor');
  return { at: new Date(Number(match[1])), id: oid(match[2]) };
};

/** A session's timeline, newest first, paged backwards. */
export const listSessionEvents = async (restaurantId, sessionId, { before, limit = LIST_LIMITS.eventsDefault } = {}) => {
  const cursor = parseCursor(before);
  const session = await findSession(restaurantId, sessionId);
  if (!session) throw sessionNotFound();
  const filter = { sessionId: session._id };
  if (cursor) filter.$or = [{ at: { $lt: cursor.at } }, { at: cursor.at, _id: { $lt: cursor.id } }];
  const rows = await ActivityEvent.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map(eventView),
    nextBefore: rows.length > limit ? `${last.at.getTime()}_${last._id}` : null,
  };
};

// ─── Creating an offer ─────────────────────────────────────────────────────

const tooLarge = (message) => new ApiError(400, 'OFFER_TOO_LARGE', message);

/** § Rules value / cap / expiry checks on an already shape-checked body. */
const checkValues = (body) => {
  const L = OFFER_LIMITS;
  if (body.maxDiscountAmount == null) throw tooLarge('maxDiscountAmount is required');
  if (body.maxDiscountAmount < L.maxDiscountMinRupees || body.maxDiscountAmount > L.maxDiscountMaxRupees) {
    throw tooLarge(`maxDiscountAmount must be ₹${L.maxDiscountMinRupees}–₹${L.maxDiscountMaxRupees}`);
  }
  if (body.type === 'percentage') {
    if (body.percentage == null || body.percentage < L.percentageMin || body.percentage > L.percentageMax) {
      throw tooLarge(`percentage must be ${L.percentageMin}–${L.percentageMax}`);
    }
  } else {
    if (body.flatAmount == null || body.flatAmount < L.flatMinRupees || body.flatAmount > L.flatMaxRupees) {
      throw tooLarge(`flatAmount must be ₹${L.flatMinRupees}–₹${L.flatMaxRupees}`);
    }
    if (body.maxDiscountAmount < body.flatAmount) throw tooLarge('maxDiscountAmount must be at least the flat amount');
  }
  if (body.expiresInMinutes < L.expiryMinMinutes || body.expiresInMinutes > L.expiryMaxMinutes) {
    throw new ApiError(400, 'INVALID_EXPIRY', `Expiry must be ${L.expiryMinMinutes} minutes to ${L.expiryMaxMinutes / 60} hours`);
  }
};

const checkItems = async (restaurantId, items = []) => {
  const ids = [...new Set(items.map(String))];
  if (ids.length === 0) return [];
  const found = await MenuItem.countDocuments({ _id: { $in: ids.map(oid) }, restaurantId });
  if (found !== ids.length) throw new ApiError(400, 'ITEM_NOT_IN_MENU', 'An item is not on this restaurant\'s menu');
  return ids.map(oid);
};

const alreadyActive = () =>
  new ApiError(409, 'OFFER_ALREADY_ACTIVE', 'This customer already has an open offer from you');

/**
 * Sends (or, with `preview`, prices) one personal offer. Checks run in a fixed order so errors
 * are predictable: session → guest → opted-out → closed → value/cap/expiry → items → open
 * offer → daily limit.
 *
 * The daily limit needs no counter or transaction. Offers for one customer + restaurant can
 * only be created one at a time: the partial unique index `one_open_personal_offer` allows a
 * single open offer, and every earlier offer must already be closed (revoked, expired or
 * redeemed) before the next insert can succeed. So counting today's offers right before the
 * insert is exact — two concurrent requests either both see the limit, or both pass the count
 * and race on the unique index, where only one wins (the other gets OFFER_ALREADY_ACTIVE).
 */
export const createOffer = async ({ restaurantId, ownerId, body }, at = now()) => {
  const session = await findSession(restaurantId, body.sessionId);
  if (!session) throw sessionNotFound();
  if (session.isGuest) throw new ApiError(409, 'GUEST_NOT_ELIGIBLE', 'Guests can\'t receive offers — they need to sign in');
  const user = await User.findById(session.userId).select('preferences.shareActivity').lean();
  if (!user || user.preferences?.shareActivity === false) {
    throw new ApiError(409, 'OPTED_OUT', 'This customer has turned activity sharing off');
  }
  if (!session.isOpen) throw new ApiError(409, 'SESSION_CLOSED', 'This visit has ended');

  checkValues(body);
  const applicableItems = await checkItems(restaurantId, body.applicableItems);

  const targetUserId = session.userId;
  if (await Discount.exists({ restaurantId, targetUserId, isOpen: true })) throw alreadyActive();
  const { start, end } = istDay(at);
  const todays = await Discount.countDocuments({
    restaurantId,
    targetUserId,
    kind: 'personal',
    createdAt: { $gte: start, $lte: end },
  });
  if (todays >= OFFER_LIMITS.maxPerCustomerPerDay) {
    throw new ApiError(409, 'DAILY_OFFER_LIMIT', `At most ${OFFER_LIMITS.maxPerCustomerPerDay} offers per customer per day`);
  }

  const terms = {
    restaurantId: oid(restaurantId),
    offerName: body.title,
    type: body.type,
    percentage: body.type === 'percentage' ? body.percentage : null,
    flatAmount: body.type === 'flat_amount' ? body.flatAmount : null,
    maxDiscountAmount: body.maxDiscountAmount,
    minimumOrderValue: body.minimumOrderValue ?? 0,
    applicableItems,
  };

  if (body.preview) {
    const cart = await Cart.findOne({ userId: targetUserId }).select('restaurantId items.menuItemId items.unitPrice items.qty').lean();
    const { issue, ...saving } = offerSaving(terms, cart);
    return { preview: { ...saving, ...(issue ? { issue } : {}) } };
  }

  let offer;
  try {
    offer = await Discount.create({
      ...terms,
      // Delivery only: the model's default `both` would let it apply to a dine-in bill.
      applicableTo: 'delivery',
      startDate: at,
      endDate: new Date(at.getTime() + body.expiresInMinutes * MINUTE_MS),
      kind: 'personal',
      targetUserId,
      sessionId: session._id,
      offerStatus: 'sent',
      isOpen: true,
      status: 'active',
      maxRedemptions: 1,
      redemptionCount: 0,
      createdBy: ownerId,
      // From the shared clock, so the IST-day count above and the stored day always agree.
      createdAt: at,
    });
  } catch (err) {
    if (err?.code === 11000) throw alreadyActive();
    throw err;
  }

  await appendSessionEvent(
    session,
    'offer_sent',
    { offerId: offer._id, offerText: offerText(offer) },
    { at, push: { offerIds: offer._id } }
  );
  const sent = offer.toObject();
  await Promise.all([publishOffer(sent, { at }), publishOfferReceived(sent)]);
  return { offer: toOfferView(sent) };
};

/** Revokes an open offer nobody has started redeeming; once, by a conditional update. */
export const revokeOffer = async ({ restaurantId, offerId }, at = now()) => {
  if (!isObjectId(String(offerId))) throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  const mine = { _id: oid(offerId), restaurantId: oid(restaurantId), kind: 'personal' };
  const offer = await Discount.findOneAndUpdate(
    { ...mine, isOpen: true, redemptionCount: 0 },
    { $set: { offerStatus: 'revoked', isOpen: false, status: 'expired', revokedAt: at } },
    { new: true, lean: true }
  );
  if (offer) {
    await publishOffer(offer, { toCustomer: true, at });
    await publishSessions([offer.sessionId].filter(Boolean));
    return { offer: toOfferView(offer) };
  }
  if (!(await Discount.exists(mine))) throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  throw new ApiError(409, 'OFFER_NOT_REVOCABLE', 'This offer is already closed or is being used on an order');
};

// ─── Offer history + metrics ───────────────────────────────────────────────

/** IST calendar day bounds for a `YYYY-MM-DD`. */
const istDate = (ymd) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new ApiError(400, 'VALIDATION_ERROR', 'Dates must be YYYY-MM-DD');
  const instant = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(instant.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid date');
  return dayBounds(instant);
};

const istYmd = (date) => new Date(date.getTime() + 330 * MINUTE_MS).toISOString().slice(0, 10);

/** Personal offers sent in an IST date range (default: the last 30 days), newest first. */
export const listOffers = async (restaurantId, { from, to, page = 1, limit = 20 } = {}, at = now()) => {
  const toDay = istDate(to ?? istYmd(at));
  const fromDay = istDate(from ?? istYmd(new Date(toDay.start.getTime() - 29 * DAY_MS)));
  const days = Math.round((toDay.start - fromDay.start) / DAY_MS) + 1;
  if (days < 1) throw new ApiError(400, 'VALIDATION_ERROR', '`from` must not be after `to`');
  if (days > LIST_LIMITS.offersRangeMaxDays) {
    throw new ApiError(400, 'VALIDATION_ERROR', `The range can be at most ${LIST_LIMITS.offersRangeMaxDays} days`);
  }

  const rows = await Discount.find({
    restaurantId,
    kind: 'personal',
    createdAt: { $gte: fromDay.start, $lte: toDay.end },
  })
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit + 1)
    .lean();
  const offers = rows.slice(0, limit);

  const sessionIds = [...new Set(offers.map((o) => String(o.sessionId)).filter((id) => id !== 'null'))].map(oid);
  const orderIds = offers.filter((o) => o.orderId).map((o) => o.orderId);
  const [sessions, orders] = await Promise.all([
    sessionIds.length ? CustomerSession.find({ _id: { $in: sessionIds } }).select('displayName').lean() : [],
    orderIds.length ? Order.find({ _id: { $in: orderIds } }).select('charges.grandTotal status').lean() : [],
  ]);
  const nameOf = new Map(sessions.map((s) => [String(s._id), s.displayName]));
  const orderOf = new Map(orders.map((o) => [String(o._id), o]));

  return {
    offers: offers.map((o) => ({
      ...toOfferView(o),
      customerName: nameOf.get(String(o.sessionId)) ?? 'Customer',
      orderTotalPaise: o.orderId ? orderOf.get(String(o.orderId))?.charges?.grandTotal ?? null : null,
    })),
    from: istYmd(fromDay.start),
    to: istYmd(toDay.start),
    page,
    limit,
    hasMore: rows.length > limit,
  };
};

export const METRIC_RANGES = { today: 1, '7d': 7, '30d': 30 };

/**
 * Offer metrics for a range of IST days ending today.
 *   - Each count is over offers CREATED in the range that ever reached that stage, read from
 *     the stage timestamps, so the funnel is monotonic: delivered ⊇ viewed ⊇ applied ⊇ redeemed
 *     (an offer viewed but never marked delivered still counts as delivered).
 *   - `expired` / `revoked` are offers created in the range now in that status.
 *   - conversionRate = redeemed / sent (0 when nothing was sent), rounded to 4 decimals.
 *   - revenuePaise / discountPaise sum the orders of redeemed offers, leaving out cancelled
 *     orders: the order's grand total and the discount it carried.
 */
export const getMetrics = async (restaurantId, range = 'today', at = now()) => {
  const days = METRIC_RANGES[range];
  const from = dayBounds(new Date(at.getTime() - (days - 1) * DAY_MS)).start;
  const reached = (fields) => ({ $cond: [{ $or: fields.map((f) => ({ $gt: [`$${f}`, null] })) }, 1, 0] });
  const [row] = await Discount.aggregate([
    { $match: { restaurantId: oid(restaurantId), kind: 'personal', createdAt: { $gte: from, $lte: at } } },
    {
      $group: {
        _id: null,
        sent: { $sum: 1 },
        delivered: { $sum: reached(['deliveredAt', 'viewedAt', 'appliedAt', 'redeemedAt']) },
        viewed: { $sum: reached(['viewedAt', 'appliedAt', 'redeemedAt']) },
        applied: { $sum: reached(['appliedAt', 'redeemedAt']) },
        redeemed: { $sum: reached(['redeemedAt']) },
        expired: { $sum: { $cond: [{ $eq: ['$offerStatus', 'expired'] }, 1, 0] } },
        revoked: { $sum: { $cond: [{ $eq: ['$offerStatus', 'revoked'] }, 1, 0] } },
        redeemedOrderIds: { $push: { $cond: [{ $gt: ['$redeemedAt', null] }, '$orderId', '$$REMOVE'] } },
      },
    },
  ]);
  const counts = row ?? { sent: 0, delivered: 0, viewed: 0, applied: 0, redeemed: 0, expired: 0, revoked: 0, redeemedOrderIds: [] };

  const orderIds = counts.redeemedOrderIds.filter(Boolean);
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds }, status: { $ne: 'cancelled' } }).select('charges discountAmount').lean()
    : [];
  const revenuePaise = orders.reduce((sum, o) => sum + (o.charges?.grandTotal ?? 0), 0);
  const discountPaise = orders.reduce((sum, o) => sum + (o.charges?.food?.discount ?? toPaise(o.discountAmount ?? 0)), 0);

  return {
    range,
    from: iso(from),
    to: iso(at),
    sent: counts.sent,
    delivered: counts.delivered,
    viewed: counts.viewed,
    applied: counts.applied,
    redeemed: counts.redeemed,
    expired: counts.expired,
    revoked: counts.revoked,
    conversionRate: counts.sent ? Math.round((counts.redeemed / counts.sent) * 10000) / 10000 : 0,
    revenuePaise,
    discountPaise,
  };
};

// ─── Customer side ─────────────────────────────────────────────────────────

/** An offer as its customer sees it — whitelisted; nothing about the owner or the session. */
// `applicableItemNames` lets the app say which dishes a dish-only offer covers ("25% off Butter
// Naan") — the ids alone left it reading as an offer on the whole order.
const toCustomerOfferView = (offer, restaurantName, dishName = new Map()) => ({
  id: String(offer._id),
  restaurant: { id: String(offer.restaurantId), name: restaurantName ?? null },
  title: offer.offerName,
  type: offer.type,
  percentage: offer.percentage ?? null,
  flatAmount: offer.flatAmount ?? null,
  maxDiscountAmount: offer.maxDiscountAmount ?? null,
  minimumOrderValue: offer.minimumOrderValue ?? 0,
  applicableItems: (offer.applicableItems ?? []).map(String),
  applicableItemNames: (offer.applicableItems ?? []).map((id) => dishName.get(String(id))).filter(Boolean),
  status: offer.offerStatus,
  expiresAt: iso(offer.endDate),
});

/** Names of the dishes these offers are limited to, in one read: id → name. */
const dishNamesFor = async (offers) => {
  const ids = [...new Set(offers.flatMap((o) => (o.applicableItems ?? []).map(String)))];
  if (ids.length === 0) return new Map();
  const items = await MenuItem.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(items.map((item) => [String(item._id), item.name]));
};

/**
 * The customer's open personal offers that haven't run out, newest first. Fetching them is
 * delivery: `sent` → `delivered` (conditional, so an offer never moves backwards). Guests have
 * none.
 */
export const listMyOffers = async (user, at = now()) => {
  if (user.role === 'guest') return [];
  const rows = (
    await Discount.find({ kind: 'personal', targetUserId: user._id, isOpen: true, endDate: { $gt: at } })
      .sort({ createdAt: -1, _id: -1 })
      .lean()
  ).filter((offer) => isLiveActivityEnabledFor(offer.restaurantId));
  if (rows.length === 0) return [];

  const sent = rows.filter((o) => o.offerStatus === 'sent').map((o) => o._id);
  const [restaurants, dishName] = await Promise.all([
    Restaurant.find({ _id: { $in: rows.map((o) => o.restaurantId) } }).select('name').lean(),
    dishNamesFor(rows),
    sent.length
      ? Discount.updateMany({ _id: { $in: sent }, offerStatus: 'sent' }, { $set: { offerStatus: 'delivered', deliveredAt: at } })
      : null,
  ]);
  const nameOf = new Map(restaurants.map((r) => [String(r._id), r.name]));
  for (const offer of rows.filter((o) => o.offerStatus === 'sent')) {
    await publishOffer({ ...offer, offerStatus: 'delivered' }, { at });
  }
  return rows.map((offer) =>
    toCustomerOfferView(
      offer.offerStatus === 'sent' ? { ...offer, offerStatus: 'delivered' } : offer,
      nameOf.get(String(offer.restaurantId)),
      dishName
    )
  );
};

/**
 * The customer opened the offer: `sent | delivered` → `viewed` once (later calls change
 * nothing). Resolves `{ offer, firstView }`; someone else's offer → 404.
 */
export const markOfferViewed = async (user, offerId, at = now()) => {
  const mine = isObjectId(String(offerId))
    ? await Discount.findOne({ _id: offerId, kind: 'personal', targetUserId: user._id }).lean()
    : null;
  if (!mine || !isLiveActivityEnabledFor(mine.restaurantId)) {
    throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  }
  const updated = await Discount.findOneAndUpdate(
    { _id: mine._id, offerStatus: { $in: ['sent', 'delivered'] } },
    [{ $set: { offerStatus: 'viewed', viewedAt: at, deliveredAt: { $ifNull: ['$deliveredAt', at] } } }],
    { new: true, lean: true }
  );
  const offer = updated ?? mine;
  if (updated) await publishOffer(updated, { at });
  const [restaurant, dishName] = await Promise.all([
    Restaurant.findById(offer.restaurantId).select('name').lean(),
    dishNamesFor([offer]),
  ]);
  return { offer: toCustomerOfferView(offer, restaurant?.name, dishName), firstView: Boolean(updated) };
};

// ─── Cancellation ──────────────────────────────────────────────────────────

/**
 * An order that redeemed a personal offer was cancelled before the restaurant accepted it
 * (customer cancel at `placed`, reject, approval timeout, unpaid-payment timeout — decided
 * 27 Oct 2026: any pre-acceptance cancellation). The redemption is undone in one update
 * guarded on `orderId: <this order>`, so a second cancel event is a no-op:
 *   - still within its expiry → reopened as `viewed` (not `applied`: the order emptied the
 *     cart, nothing holds the offer now, and it is not put back on any cart);
 *   - past its expiry, or the owner has since sent a newer open offer (the one-open-offer
 *     index refuses the reopen) → `expired`.
 * Resolves the new status, or null when there was nothing to release.
 */
export const releaseOfferForCancelledOrder = async (order, at = now()) => {
  if (!order?.appliedDiscountId) return null;
  const redeemedBy = { _id: order.appliedDiscountId, kind: 'personal', orderId: order._id, redemptionCount: { $gt: 0 } };
  const undo = { $inc: { redemptionCount: -1 } };
  const cleared = { orderId: null, redeemedAt: null };
  const announce = async (offer) => {
    await publishOffer(offer, { toCustomer: true, at });
    await publishSessions([offer.sessionId].filter(Boolean));
  };
  try {
    const reopened = await Discount.findOneAndUpdate(
      { ...redeemedBy, endDate: { $gt: at } },
      { ...undo, $set: { ...cleared, offerStatus: 'viewed', isOpen: true, status: 'active' } },
      { new: true, lean: true }
    );
    if (reopened) {
      await announce(reopened);
      return 'viewed';
    }
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  const expired = await Discount.findOneAndUpdate(
    redeemedBy,
    { ...undo, $set: { ...cleared, offerStatus: 'expired', isOpen: false, status: 'expired' } },
    { new: true, lean: true }
  );
  if (!expired) return null;
  await announce(expired);
  return 'expired';
};

/**
 * Delivery receipt from the customer's app (socket `offer_ack`): `sent` → `delivered` once.
 * Someone else's offer, an unknown id or an already-delivered one changes nothing — and the
 * caller can't tell which. Resolves true when this call delivered it.
 */
export const markOfferDelivered = async (userId, offerId, at = now()) => {
  if (!isObjectId(String(offerId))) return false;
  const offer = await Discount.findOneAndUpdate(
    { _id: offerId, kind: 'personal', targetUserId: userId, offerStatus: 'sent' },
    { $set: { offerStatus: 'delivered', deliveredAt: at } },
    { new: true, lean: true }
  );
  if (!offer || !isLiveActivityEnabledFor(offer.restaurantId)) return false;
  await publishOffer(offer, { at });
  return true;
};
