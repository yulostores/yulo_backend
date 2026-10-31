import crypto from 'crypto';
import { z } from 'zod';
import Order from '../../models/Order.js';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import Restaurant from '../../models/Restaurant.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { maxConcurrentOrdersPerPartner } from '../../config/finance.config.js';
import { onOrderDelivered, withoutInternalMoney } from '../../services/ledger.service.js';
import { createOrderBill } from '../../services/billing.service.js';
import { notifyService } from '../../services/notify.service.js';
import {
  autoAssign,
  expireIfStale,
  buildOfferPayload,
  computeRiderEarningsBreakdown,
  countActiveAssignments,
  countCompletedDelivery,
  ASSIGNABLE_STATUSES,
} from '../../services/deliveryAssignment.service.js';
import { computeDropKm, computePickupKm, isLocationFresh } from '../../services/geo.service.js';

const assertOfferBelongsToPartner = (order, partnerId) => {
  if (
    order.deliveryAssignment.offerStatus !== 'offered' ||
    order.deliveryAssignment.offeredTo?.toString() !== partnerId.toString()
  ) {
    throw new ApiError(403, 'NOT_YOUR_OFFER', 'This order was not offered to you');
  }
};

const assertOrderBelongsToPartner = (order, partnerId) => {
  if (order.deliveryAssignment.partnerId?.toString() !== partnerId.toString()) {
    throw new ApiError(403, 'NOT_YOUR_ORDER', 'This order is not assigned to you');
  }
};

const generatePickupOtp = () => String(crypto.randomInt(0, 10_000)).padStart(4, '0');
// Same shape as the pickup code — four digits the customer reads out at the door.
const generateDeliveryOtp = generatePickupOtp;

// Wrong delivery codes a rider may enter before the order is locked to support. Enough for a
// misheard digit or two; few enough that guessing 4 digits is hopeless.
export const DELIVERY_OTP_MAX_ATTEMPTS = 5;

// Not security-critical for a 4-digit code (an attacker within a few requests either way isn't
// meaningfully slowed down), but a plain `===` on user input invites the habit — cheap to do
// right. Requires equal-length buffers; a mismatched length (or missing pickupOtp) just means
// "not equal", handled naturally below rather than needing a separate branch.
const otpMatches = (submitted, stored) => {
  if (typeof stored !== 'string' || submitted.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored));
};

// A cancelled order is out of the rider's hands (its assignment is released when it is
// cancelled); refuse anything a stale screen still tries to do with it.
const assertNotCancelled = (order, partnerId = null) => {
  // Told only to a rider who held (or was offered) it — anyone else just isn't its rider.
  const involved =
    !partnerId ||
    order.deliveryAssignment?.partnerId?.toString() === partnerId.toString() ||
    (order.deliveryAssignment?.history ?? []).some((h) => h.partnerId?.toString() === partnerId.toString());
  if (order.status === 'cancelled' && involved) {
    throw new ApiError(409, 'ORDER_CANCELLED', 'This order was cancelled — do not collect or deliver it');
  }
};

// A conditional write matched nothing: say why, from the order as it is now.
const refuseChangedOrder = async (orderId) => {
  const current = await Order.findById(orderId).select('status deliveryAssignment.status').lean();
  if (current?.status === 'cancelled') assertNotCancelled(current);
  throw new ApiError(
    409,
    'CONCURRENT_UPDATE',
    `This delivery was just updated (now '${current?.deliveryAssignment?.status ?? 'unknown'}') — please refresh`
  );
};

export const acceptOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  if (await expireIfStale(order)) {
    throw new ApiError(409, 'OFFER_EXPIRED', 'This offer has expired');
  }
  // An offer withdrawn because the order was cancelled: say so to the rider it was offered to.
  if (!ASSIGNABLE_STATUSES.includes(order.status) && order.deliveryAssignment.offeredTo?.toString() === req.partner._id.toString()) {
    throw new ApiError(409, 'ORDER_UNAVAILABLE', 'This order is no longer available');
  }
  assertOfferBelongsToPartner(order, req.partner._id);

  // The offer can outlive the order: the kitchen may cancel it (or, for an order offered
  // before the restaurant-approval step existed, the restaurant may reject it) while the
  // offer is still on the rider's screen. Close the offer out instead of assigning a rider
  // to food nobody is cooking.
  const closeOffer = async () => {
    await Order.updateOne(
      { _id: order._id, 'deliveryAssignment.offerStatus': 'offered', 'deliveryAssignment.offeredTo': req.partner._id },
      { $set: { 'deliveryAssignment.offerStatus': 'expired' } }
    );
    throw new ApiError(409, 'ORDER_UNAVAILABLE', 'This order is no longer available');
  };
  if (!ASSIGNABLE_STATUSES.includes(order.status)) await closeOffer();

  const now = new Date();
  // The rider's pay is fixed now, at acceptance — the figure the offer showed them.
  const earningsBreakdown = await computeRiderEarningsBreakdown(order);
  // A partner only ever reaches this point on a vegFleetOptIn order because
  // rankCandidates' requireFleetType already restricted the offer to a veg-fleet partner
  // (or the customer explicitly relaxed that via fallback) — either way, an actual
  // assignment now exists, so the countdown/decision UI (screen 23) is done.
  const wasSearchingVegFleet = order.vegFleetOptIn && order.vegFleetAssignmentStatus !== 'not_requested';
  // One conditional write: the offer must still be this rider's and the order still able to take
  // a rider. A cancellation at the same instant either lands first (this matches nothing) or
  // second (and releases this assignment — services/deliveryAssignment.service.js).
  const accepted = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: { $in: ASSIGNABLE_STATUSES },
      'deliveryAssignment.offerStatus': 'offered',
      'deliveryAssignment.offeredTo': req.partner._id,
    },
    {
      $set: {
        'deliveryAssignment.status': 'assigned',
        'deliveryAssignment.partnerId': req.partner._id,
        'deliveryAssignment.assignedAt': now,
        'deliveryAssignment.assignedBy': 'auto',
        'deliveryAssignment.offerStatus': 'accepted',
        'deliveryAssignment.pickupOtp': generatePickupOtp(),
        'deliveryAssignment.earningsBreakdown': earningsBreakdown,
        ...(wasSearchingVegFleet ? { vegFleetAssignmentStatus: 'assigned', vegFleetSearchDeadline: null } : {}),
      },
      $push: { 'deliveryAssignment.history': { partnerId: req.partner._id, assignedAt: now, assignedBy: 'auto' } },
    },
    { new: true }
  );
  if (!accepted) {
    const current = await Order.findById(order._id).select('status').lean();
    if (!ASSIGNABLE_STATUSES.includes(current?.status)) await closeOffer();
    throw new ApiError(409, 'OFFER_EXPIRED', 'This offer is no longer yours');
  }
  if (wasSearchingVegFleet) notifyService.vegFleetStatusUpdated(accepted);
  notifyService.deliveryAssignmentUpdated(accepted, req.partner);

  // Mirrors the old synchronous autoAssign's behavior: mark the partner busy once this
  // acceptance pushes them to their concurrency limit, so they're skipped for further offers.
  const activeCount = await countActiveAssignments(req.partner._id);
  if (activeCount >= maxConcurrentOrdersPerPartner) {
    await DeliveryPartner.updateOne({ _id: req.partner._id }, { $set: { status: 'busy' } });
  }

  sendSuccess(res, 200, 'Order accepted', { order: withoutInternalMoney(accepted) });
});

// Must stay in sync with Delivery-Partner/src/mocks/fixtures.js's SKIP_REASONS.
const SKIP_REASONS = [
  'Restaurant too far',
  'Drop location too far',
  'Too many active orders',
  'Taking a break',
  'Other',
];

const rejectSchema = z
  .object({
    reason: z.enum(SKIP_REASONS),
    notes: z.string().optional(),
  })
  .refine((data) => data.reason !== 'Other' || Boolean(data.notes), {
    message: 'notes is required when reason is "Other"',
    path: ['notes'],
  });

export const rejectOrder = asyncHandler(async (req, res) => {
  const result = rejectSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid reject reason', result.error.flatten());
  }
  const { reason, notes } = result.data;

  const order = await Order.findById(req.params.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  if (await expireIfStale(order)) {
    throw new ApiError(409, 'OFFER_EXPIRED', 'This offer has already expired');
  }
  assertOfferBelongsToPartner(order, req.partner._id);

  const now = new Date();
  order.deliveryAssignment.offerStatus = 'rejected';
  order.deliveryAssignment.history.push({
    partnerId: req.partner._id,
    assignedAt: now,
    assignedBy: 'auto',
    unassignedAt: now,
    reason: reason === 'Other' ? notes : reason,
  });
  await order.save();

  const nextPartnerId = await autoAssign(order);

  sendSuccess(res, 200, 'Order rejected', { reassigned: Boolean(nextPartnerId) });
});

export const getCurrentOrder = asyncHandler(async (req, res) => {
  // An 'offered'-but-not-yet-accepted order counts as "current" too — the partner may have
  // backgrounded the app mid-offer. If it's since expired, lazily expire + reassign before
  // answering, so we never resume the partner into an offer that's no longer theirs.
  const offered = await Order.findOne({
    'deliveryAssignment.offeredTo': req.partner._id,
    'deliveryAssignment.offerStatus': 'offered',
  });
  if (offered) {
    const wasExpired = await expireIfStale(offered);
    if (wasExpired) {
      return sendSuccess(res, 200, 'Current order', { kind: 'none', order: null });
    }
    const payload = await buildOfferPayload(offered, req.partner);
    return sendSuccess(res, 200, 'Current order', { kind: 'offer', order: payload });
  }

  const assigned = await Order.findOne({
    'deliveryAssignment.partnerId': req.partner._id,
    'deliveryAssignment.status': { $in: ['assigned', 'picked_up'] },
  }).lean();

  if (!assigned) {
    return sendSuccess(res, 200, 'Current order', { kind: 'none', order: null });
  }
  // Reshaped through buildOfferPayload rather than returned as the raw Mongoose document —
  // NavigationScreen.jsx (both GoToPickup and NavigateToCustomer) reads the flat
  // restaurantName/restaurantAddress/pickupKm/restaurantLocation/dropoffLocation shape that
  // shape produces, same as it does for the 'offer' branch above. Previously this branch
  // returned the raw order (with restaurantId only populated 'name address', no coordinates
  // at all) — harmless while every real navigation always arrived via IncomingOrder.jsx's
  // already-shaped in-memory object, but it meant reopening the app mid-delivery (the one
  // path that actually hits this branch) landed on a screen with no name, address, distance,
  // or map pins. buildOfferPayload does its own Restaurant lookup, so no populate needed here.
  const payload = await buildOfferPayload(assigned, req.partner);
  sendSuccess(res, 200, 'Current order', { kind: 'assigned', order: payload });
});

const verifyPickupSchema = z.object({
  otp: z.string().length(4),
  packagingChecklist: z
    .object({ sealIntact: z.boolean(), tempBagUsed: z.boolean() })
    .optional(),
});

export const verifyPickup = asyncHandler(async (req, res) => {
  const result = verifyPickupSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid pickup verification', result.error.flatten());
  }
  const { otp, packagingChecklist } = result.data;

  const order = await Order.findById(req.params.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  assertNotCancelled(order, req.partner._id);
  assertOrderBelongsToPartner(order, req.partner._id);

  if (order.deliveryAssignment.status !== 'assigned') {
    throw new ApiError(
      400,
      'INVALID_STATE',
      `Cannot verify pickup from status '${order.deliveryAssignment.status}'`
    );
  }

  if (!otpMatches(otp, order.deliveryAssignment.pickupOtp)) {
    throw new ApiError(400, 'INVALID_OTP', 'Incorrect pickup OTP');
  }

  // fleetType reflects the PARTNER, not the order (see deliveryAssignment.service.js's
  // buildOfferPayload comment) — a veg-fleet partner always needs the packaging checklist,
  // regardless of what's actually in this particular order.
  if (req.partner.fleetType === 'veg') {
    if (!packagingChecklist?.sealIntact || !packagingChecklist?.tempBagUsed) {
      throw new ApiError(
        400,
        'CHECKLIST_INCOMPLETE',
        'Complete the veg packaging checklist before confirming pickup'
      );
    }
  }

  // Conditional, so a cancellation landing between the read above and now wins.
  const pickedUpAt = new Date();
  const picked = await Order.updateOne(
    {
      _id: order._id,
      status: { $ne: 'cancelled' },
      'deliveryAssignment.status': 'assigned',
      'deliveryAssignment.partnerId': req.partner._id,
    },
    {
      $set: {
        'deliveryAssignment.status': 'picked_up',
        'deliveryAssignment.pickupOtpVerifiedAt': pickedUpAt,
        // The doorstep code starts to exist only now, when there is food on its way to hand over.
        'deliveryAssignment.deliveryOtp': generateDeliveryOtp(),
        'deliveryAssignment.deliveryOtpAttempts': 0,
      },
    }
  );
  if (!picked.modifiedCount) await refuseChangedOrder(order._id);
  order.deliveryAssignment.status = 'picked_up';
  order.deliveryAssignment.pickupOtpVerifiedAt = pickedUpAt;
  notifyService.deliveryAssignmentUpdated(order, req.partner);

  // The verified pickup OTP is the handoff itself, so it moves the order on to
  // 'out_for_delivery'. Before, only the kitchen's "Out for Delivery" button did — when the
  // chef didn't press it, the customer kept seeing "Ready for pickup" while the food was on
  // its way. From 'confirmed'/'preparing' too: a kitchen that never pressed "Ready" left the
  // customer reading "Preparing" for the whole ride, and the verified OTP already proves the
  // food left the counter. Conditional: a kitchen that already moved it on (or a cancellation)
  // wins, and the history entry is written once.
  const historyEntry = {
    status: 'out_for_delivery',
    at: pickedUpAt,
    byStaffName: req.partner.fullName ?? null,
    byRole: 'delivery_partner',
  };
  const handedOff = await Order.updateOne(
    { _id: order._id, status: { $in: ['confirmed', 'preparing', 'ready'] } },
    { $set: { status: 'out_for_delivery' }, $push: { statusHistory: historyEntry } }
  );
  if (handedOff.modifiedCount) {
    order.status = 'out_for_delivery';
    order.statusHistory.push(historyEntry);
    notifyService.orderStatusUpdated(order);
  }

  sendSuccess(res, 200, 'Pickup confirmed', { order: withoutInternalMoney(order) });
});

// Cash the rider says they collected, in rupees — at most two decimals, and capped so a
// slip of the finger (or a crafted request) can't put an absurd figure into cash-in-hand.
const MAX_COD_COLLECTED = 100_000;
const deliverSchema = z.object({
  // The customer's delivery code (shown in their app). Required for every order picked up since
  // delivery codes exist; an order collected before then has none and isn't asked for one.
  otp: z.string().regex(/^\d{4}$/, 'Enter the 4-digit code from the customer').optional(),
  codCollected: z
    .number()
    .min(0)
    .max(MAX_COD_COLLECTED)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'At most two decimal places')
    .optional(),
});

export const deliverOrder = asyncHandler(async (req, res) => {
  const result = deliverSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid delivery confirmation', result.error.flatten());
  }
  const { codCollected, otp } = result.data;

  const found = await Order.findById(req.params.orderId).select('+deliveryAssignment.deliveryOtp');
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  assertNotCancelled(found, req.partner._id);
  assertOrderBelongsToPartner(found, req.partner._id);

  if (found.deliveryAssignment.status !== 'picked_up') {
    throw new ApiError(
      400,
      'INVALID_STATE',
      `Cannot deliver from status '${found.deliveryAssignment.status}'`
    );
  }
  // The doorstep code: proof the customer was there to take the order.
  const expectedOtp = found.deliveryAssignment.deliveryOtp;
  if (expectedOtp) {
    if ((found.deliveryAssignment.deliveryOtpAttempts ?? 0) >= DELIVERY_OTP_MAX_ATTEMPTS) {
      throw new ApiError(
        423,
        'DELIVERY_OTP_LOCKED',
        'Too many wrong codes. Call support to close this delivery.'
      );
    }
    if (!otp) {
      throw new ApiError(400, 'DELIVERY_OTP_REQUIRED', 'Ask the customer for their 4-digit delivery code');
    }
    if (!otpMatches(otp, expectedOtp)) {
      const after = await Order.findOneAndUpdate(
        { _id: found._id },
        { $inc: { 'deliveryAssignment.deliveryOtpAttempts': 1 } },
        { new: true, projection: { 'deliveryAssignment.deliveryOtpAttempts': 1 } }
      ).lean();
      const left = Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - (after?.deliveryAssignment?.deliveryOtpAttempts ?? DELIVERY_OTP_MAX_ATTEMPTS));
      if (left === 0) {
        throw new ApiError(
          423,
          'DELIVERY_OTP_LOCKED',
          'Too many wrong codes. Call support to close this delivery.'
        );
      }
      throw new ApiError(400, 'INVALID_OTP', `Incorrect delivery code — ${left} ${left === 1 ? 'try' : 'tries'} left`, {
        attemptsLeft: left,
      });
    }
  }

  const isCod = found.paymentMethod === 'cash';
  if (isCod && codCollected === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'codCollected is required for COD orders');
  }
  // The rider's pay was frozen when they accepted the order (computeRiderEarningsBreakdown).
  // Only an order assigned before that existed lacks it — worked out now, once, before the
  // handover is claimed so nothing after the claim can fail.
  const legacyBreakdown = found.deliveryAssignment.earningsBreakdown?.computedAt
    ? null
    : await computeRiderEarningsBreakdown(found);

  // Claim the handover atomically: only while the order isn't cancelled and this rider still
  // holds it. A cancellation can't land after this (kitchen.service.js refuses to cancel a
  // delivered assignment), so exactly one of the two wins.
  const order = await Order.findOneAndUpdate(
    {
      _id: found._id,
      status: { $ne: 'cancelled' },
      'deliveryAssignment.status': 'picked_up',
      'deliveryAssignment.partnerId': req.partner._id,
    },
    {
      $set: {
        'deliveryAssignment.status': 'delivered',
        ...(expectedOtp ? { 'deliveryAssignment.deliveryOtpVerifiedAt': new Date() } : {}),
      },
    },
    { new: true }
  );
  if (!order) await refuseChangedOrder(found._id);

  if (isCod) {
    order.deliveryAssignment.codCollected = codCollected;
    // CodCollection.jsx today is a fully self-reported "Mark cash received" toggle with no real
    // payment-gateway/QR verification behind it — there is nothing to authoritatively check the
    // collected amount against. Hard-failing the delivery on a mismatch would block a legitimate,
    // already-physically-completed handover over what might just be a rounding difference —
    // unlike a card/UPI charge, this money has already changed hands in person by this point.
    // So: flag the discrepancy for later admin/payout review instead of blocking, and persist it.
    // Measured against what the customer actually owes (grandTotal: food, fees, GST, tip) —
    // it used to be the food `subtotal`, which flagged almost every COD order.
    const owed = order.grandTotal ?? order.subtotal;
    order.deliveryAssignment.codDiscrepancy =
      codCollected === owed ? null : Number((codCollected - owed).toFixed(2));
  }

  if (legacyBreakdown && !order.deliveryAssignment.earningsBreakdown?.computedAt) {
    order.deliveryAssignment.earningsBreakdown = legacyBreakdown;
  }

  order.deliveryAssignment.status = 'delivered';
  order.deliveredAt = new Date();
  // 'pending_cod' (checkout-flow COD orders, Prompt 11) means the same thing 'pending'
  // used to mean here for a cash order — cash collected in person, now confirmed by the
  // partner. Still covers plain 'pending' too, for the raw-items POST /api/orders path,
  // which never sets 'pending_cod'.
  // Never an online order: its 'pending' means "Razorpay payment not confirmed", and handing the
  // food over doesn't change that (same rule as kitchen.service.js's delivered transition).
  if (
    order.paymentStatus === 'pending_cod' ||
    (order.paymentStatus === 'pending' && order.paymentMethod !== 'online')
  ) {
    order.paymentStatus = 'paid';
  }

  // kitchen.service.js's updateOrderStatus already does this same (order.status='delivered' +
  // createOrderBill) when a delivered transition comes from the kitchen side — read that logic
  // before writing this. This endpoint is the partner-driven equivalent for delivery orders (the
  // realistic path going forward: kitchen hands off at 'out_for_delivery', but only the partner
  // actually knows when the food reached the customer). Guarded with the same idempotency check
  // kitchen.service.js effectively gets from its optimistic findOneAndUpdate, so if kitchen
  // already independently marked this delivered first, this doesn't re-run/double-bill.
  if (order.status !== 'delivered') {
    order.status = 'delivered';
    // kitchen.service.js's updateOrderStatus pushes this same entry for a kitchen-driven
    // delivered transition — mirrored here so the audit trail (and the owner's per-order
    // timeline) reads correctly regardless of which side actually closed the order out.
    order.statusHistory.push({
      status: 'delivered',
      at: new Date(),
      byStaffName: req.partner.fullName ?? null,
      byRole: 'delivery_partner',
    });
    await order.save();
    await createOrderBill(order);
    notifyService.orderStatusUpdated(order);
  } else {
    await order.save();
  }
  // The restaurant's credit for an order paid online. Idempotent, so it is safe whichever of
  // the kitchen and the rider closed the order out first.
  await onOrderDelivered(order);
  // The rider's delivery count — once per order, however it was closed out.
  await countCompletedDelivery(order._id);
  // deliveryAssignment.status just moved to 'delivered' in both branches above — the
  // customer's tracking screen and the restaurant's live views need this even when
  // kitchen already independently marked the order delivered first.
  notifyService.deliveryAssignmentUpdated(order, req.partner);

  // Mirror acceptOrder's busy-marking in reverse: nothing else ever releases a partner back to
  // 'active' once accepting an order pushed them to their concurrency limit. Without this, a
  // partner would be permanently stuck 'busy' after their very first delivery — duty.controller.js
  // blocks any status change at all while 'busy' (see Step 5), so they'd have no way to ever go
  // online again. Only flips busy->active (query-gated), a no-op if they're in any other state.
  const activeCount = await countActiveAssignments(req.partner._id);
  if (activeCount < maxConcurrentOrdersPerPartner) {
    await DeliveryPartner.updateOne({ _id: req.partner._id, status: 'busy' }, { $set: { status: 'active' } });
  }

  sendSuccess(res, 200, 'Order delivered', { order: withoutInternalMoney(order) });
});

// The rider's pay for one delivery as the summary shows it: every part present (0 when a
// legacy breakdown lacks surge/penalty) and the total worked out here, not on the device —
// the same sum the earnings endpoint's per-delivery lines use.
const summaryPayout = (e = {}) => {
  const p = {
    basePay: e.basePay ?? 0,
    distancePay: e.distancePay ?? 0,
    surge: e.surgePay ?? 0,
    tip: e.tip ?? 0,
    penalty: e.penalty ?? 0,
  };
  return { ...p, total: Math.round((p.basePay + p.distancePay + p.surge + p.tip - p.penalty) * 100) / 100 };
};

export const getOrderSummary = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  assertOrderBelongsToPartner(order, req.partner._id);

  // Once delivered, the breakdown is frozen (deliverOrder computes it exactly once) — return
  // those real numbers, not a re-estimate, so DeliverySummary.jsx shows what was actually earned.
  if (order.deliveryAssignment.status === 'delivered' && order.deliveryAssignment.earningsBreakdown) {
    const breakdown = order.deliveryAssignment.earningsBreakdown;
    return sendSuccess(res, 200, 'Order summary', {
      totalKm: breakdown.distanceKm,
      payout: summaryPayout(breakdown),
    });
  }

  // Not yet delivered — this is only a preview estimate (flat rate, no distance/surge/tip yet),
  // not the frozen figure deliverOrder will compute. pickupKm/totalKm use the same
  // fresh-location-or-null logic as buildOfferPayload, so this preview doesn't disagree with what
  // the partner already saw on the incoming-offer card for the same order.
  const restaurant = await Restaurant.findById(order.restaurantId).select('location').lean();
  const dropKm = computeDropKm(restaurant, order);
  const pickupKm = isLocationFresh(req.partner.currentLocationUpdatedAt)
    ? computePickupKm(req.partner.currentLocation, restaurant)
    : null;
  // null unless BOTH legs are known — matches buildOfferPayload's totalKm exactly, rather than
  // silently calling drop-distance-alone "total" the way this endpoint used to.
  const totalKm = pickupKm != null && dropKm != null ? Number((pickupKm + dropKm).toFixed(1)) : null;

  sendSuccess(res, 200, 'Order summary', {
    totalKm,
    payout: await (async () => {
      // The figure frozen at acceptance; worked out fresh only for an order assigned before that.
      const e = order.deliveryAssignment.earningsBreakdown?.computedAt
        ? order.deliveryAssignment.earningsBreakdown
        : await computeRiderEarningsBreakdown(order);
      return summaryPayout(e);
    })(),
  });
});
