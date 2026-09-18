import { z } from 'zod';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import Order from '../../models/Order.js';
import { getIO } from '../../socket.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';

// [lng, lat], GeoJSON order — matches every other coordinates field in this codebase
// (Restaurant.location, Order.deliveryAddress.coordinates).
const locationSchema = z.object({
  coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  // Compass bearing in degrees. Optional because a stationary GPS fix has no meaningful
  // heading — the device reports -1 — and because older builds of the partner app do not
  // send it at all. When present the customer's map rotates the rider marker to match, which
  // is most of what separates a live-looking map from a dot that teleports.
  heading: z.number().min(0).max(360).optional(),
  // Metres per second, straight from the GPS fix. Used only for display smoothing on the
  // customer side; never trusted for ETA, which comes from road routing.
  speed: z.number().min(0).optional(),
});

// Which assignment states mean "a customer is currently watching for this rider".
//
// This used to be `picked_up` alone, which meant the customer could not see the rider until the
// food was already in the bag — the entire "your rider is reaching the restaurant" phase was
// invisible. Both legs are broadcast now; the customer app decides how to label each one from
// the assignment status it already has.
const TRACKABLE_ASSIGNMENT_STATUSES = ['assigned', 'picked_up'];

export const updateLocation = asyncHandler(async (req, res) => {
  const result = locationSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid coordinates', result.error.flatten());
  }

  const { coordinates, heading, speed } = result.data;

  // `type` and `coordinates` are always set together here — never let a partial GeoJSON value
  // exist on this document (see the schema comment on DeliveryPartner.currentLocation).
  await DeliveryPartner.updateOne(
    { _id: req.partner._id },
    {
      $set: {
        currentLocation: { type: 'Point', coordinates },
        currentLocationUpdatedAt: new Date(),
      },
    }
  );

  // Live-only broadcast to whichever order this partner is actively working (if any) — no
  // location-history collection, matching this codebase's established "don't over-engineer live
  // state" precedent (see geo.service.js's LOCATION_FRESHNESS_SECONDS: only the latest ping is
  // ever kept, nothing is archived).
  const activeOrder = await Order.findOne({
    'deliveryAssignment.partnerId': req.partner._id,
    'deliveryAssignment.status': { $in: TRACKABLE_ASSIGNMENT_STATUSES },
  })
    .select('_id deliveryAssignment.status')
    .lean();

  if (activeOrder) {
    const [lng, lat] = coordinates;
    try {
      getIO().to(`order:${activeOrder._id}`).emit('partner_location_updated', {
        orderId: activeOrder._id,
        lat,
        lng,
        // A stationary device reports heading as -1; normalise that to null so the client can
        // simply keep the last known bearing rather than snapping the marker to due north.
        heading: heading != null && heading >= 0 ? heading : null,
        speed: speed ?? null,
        // Lets the customer app label the leg ("reaching the restaurant" vs "on the way to you")
        // from the socket payload alone, without refetching the whole tracking document.
        assignmentStatus: activeOrder.deliveryAssignment?.status ?? null,
      });
    } catch (err) {
      logger.error({ err, orderId: activeOrder._id }, 'Failed to emit partner_location_updated');
    }
  }

  sendSuccess(res, 200, 'Location updated', null);
});
