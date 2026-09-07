import crypto from 'crypto';
import { z } from 'zod';
import Order from '../../models/Order.js';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import Restaurant from '../../models/Restaurant.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { maxConcurrentOrdersPerPartner, perDeliveryRate, perKmRate } from '../../config/finance.config.js';
import { createOrderBill } from '../../services/billing.service.js';
import { notifyService } from '../../services/notify.service.js';
import {
  autoAssign,
  expireIfStale,
  buildOfferPayload,
  countActiveAssignments,
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

// Not security-critical for a 4-digit code (an attacker within a few requests either way isn't
// meaningfully slowed down), but a plain `===` on user input invites the habit — cheap to do
// right. Requires equal-length buffers; a mismatched length (or missing pickupOtp) just means
// "not equal", handled naturally below rather than needing a separate branch.
const otpMatches = (submitted, stored) => {
  if (typeof stored !== 'string' || submitted.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored));
};

export const acceptOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  if (await expireIfStale(order)) {
    throw new ApiError(409, 'OFFER_EXPIRED', 'This offer has expired');
  }
  assertOfferBelongsToPartner(order, req.partner._id);

  const now = new Date();
  order.deliveryAssignment.status = 'assigned';
  order.deliveryAssignment.partnerId = req.partner._id;
  order.deliveryAssignment.assignedAt = now;
  order.deliveryAssignment.assignedBy = 'auto';
  order.deliveryAssignment.offerStatus = 'accepted';
  order.deliveryAssignment.pickupOtp = generatePickupOtp();
  order.deliveryAssignment.history.push({
    partnerId: req.partner._id,
    assignedAt: now,
    assignedBy: 'auto',
  });
  // A partner only ever reaches this point on a vegFleetOptIn order because
  // rankCandidates' requireFleetType already restricted the offer to a veg-fleet partner
  // (or the customer explicitly relaxed that via fallback) — either way, an actual
  // assignment now exists, so the countdown/decision UI (screen 23) is done.
  const wasSearchingVegFleet = order.vegFleetOptIn && order.vegFleetAssignmentStatus !== 'not_requested';
  if (wasSearchingVegFleet) {
    order.vegFleetAssignmentStatus = 'assigned';
    order.vegFleetSearchDeadline = null;
  }
  await order.save();
  if (wasSearchingVegFleet) notifyService.vegFleetStatusUpdated(order);
  notifyService.deliveryAssignmentUpdated(order, req.partner);

  // Mirrors the old synchronous autoAssign's behavior: mark the partner busy once this
  // acceptance pushes them to their concurrency limit, so they're skipped for further offers.
  const activeCount = await countActiveAssignments(req.partner._id);
  if (activeCount >= maxConcurrentOrdersPerPartner) {
    await DeliveryPartner.updateOne({ _id: req.partner._id }, { $set: { status: 'busy' } });
  }

  sendSuccess(res, 200, 'Order accepted', { order });
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
  })
    .populate('restaurantId', 'name address')
    .lean();

  if (!assigned) {
    return sendSuccess(res, 200, 'Current order', { kind: 'none', order: null });
  }
  sendSuccess(res, 200, 'Current order', { kind: 'assigned', order: assigned });
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

  order.deliveryAssignment.status = 'picked_up';
  order.deliveryAssignment.pickupOtpVerifiedAt = new Date();
  await order.save();
  notifyService.deliveryAssignmentUpdated(order, req.partner);

  sendSuccess(res, 200, 'Pickup confirmed', { order });
});

const deliverSchema = z.object({ codCollected: z.number().min(0).optional() });

export const deliverOrder = asyncHandler(async (req, res) => {
  const result = deliverSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid delivery confirmation', result.error.flatten());
  }
  const { codCollected } = result.data;

  const order = await Order.findById(req.params.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  assertOrderBelongsToPartner(order, req.partner._id);

  if (order.deliveryAssignment.status !== 'picked_up') {
    throw new ApiError(
      400,
      'INVALID_STATE',
      `Cannot deliver from status '${order.deliveryAssignment.status}'`
    );
  }

  const isCod = order.paymentMethod === 'cash';
  if (isCod) {
    if (codCollected === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'codCollected is required for COD orders');
    }
    order.deliveryAssignment.codCollected = codCollected;
    // CodCollection.jsx today is a fully self-reported "Mark cash received" toggle with no real
    // payment-gateway/QR verification behind it — there is nothing to authoritatively check the
    // collected amount against. Hard-failing the delivery on a mismatch would block a legitimate,
    // already-physically-completed handover over what might just be a rounding difference or a
    // tip the rider folded in differently than `subtotal` — unlike a card/UPI charge, this money
    // has already changed hands in person by this point. So: flag the discrepancy for later
    // admin/payout review instead of blocking, and persist it (not just return it in this
    // response) so it's actually reviewable once an admin view for it exists.
    order.deliveryAssignment.codDiscrepancy =
      codCollected === order.subtotal ? null : codCollected - order.subtotal;
  }

  // Computed once, here, and never recomputed later — see the schema comment on
  // earningsBreakdown. basePay alone is the real, admin-funded rate (matches
  // payout.service.js's grossEarnings exactly by construction); distancePay is a placeholder
  // formula (perKmRate — see finance.config.js) using whatever real distance figure is
  // available, 0 when it isn't; surgePay/tip/penalty stay 0 (no engine for any of them exists).
  const restaurant = await Restaurant.findById(order.restaurantId).select('location').lean();
  const distanceKm = computeDropKm(restaurant, order);
  order.deliveryAssignment.earningsBreakdown = {
    basePay: perDeliveryRate,
    distanceKm,
    distancePay: distanceKm ? Number((distanceKm * perKmRate).toFixed(2)) : 0,
    surgePay: 0,
    tip: 0,
    penalty: 0,
  };

  order.deliveryAssignment.status = 'delivered';
  order.deliveredAt = new Date();
  // 'pending_cod' (checkout-flow COD orders, Prompt 11) means the same thing 'pending'
  // used to mean here for a cash order — cash collected in person, now confirmed by the
  // partner. Still covers plain 'pending' too, for the raw-items POST /api/orders path,
  // which never sets 'pending_cod'.
  if (order.paymentStatus === 'pending' || order.paymentStatus === 'pending_cod') {
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

  sendSuccess(res, 200, 'Order delivered', { order });
});

export const getOrderSummary = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  assertOrderBelongsToPartner(order, req.partner._id);

  // Once delivered, the breakdown is frozen (deliverOrder computes it exactly once) — return
  // those real numbers, not a re-estimate, so DeliverySummary.jsx shows what was actually earned.
  if (order.deliveryAssignment.status === 'delivered' && order.deliveryAssignment.earningsBreakdown) {
    const { basePay, distanceKm, distancePay, surgePay, tip, penalty } = order.deliveryAssignment.earningsBreakdown;
    return sendSuccess(res, 200, 'Order summary', {
      totalKm: distanceKm,
      payout: { basePay, distancePay, surge: surgePay, tip, penalty },
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
    payout: { basePay: perDeliveryRate, distancePay: 0, surge: 0, tip: 0, penalty: 0 },
  });
});
