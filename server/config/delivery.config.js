// How far a restaurant's food travels — the one place the delivery-zone rule lives.
//
// A restaurant is listed for a customer when the customer's delivery pin is inside THAT
// restaurant's own delivery radius (Restaurant.delivery.radiusKm), the way Swiggy/Zomato
// gate "restaurants near you" — not inside a radius the client picks. The home feed, the
// restaurant list and /api/geo/serviceability all read it from here so a customer can never
// be told "we deliver here" by one screen and shown an empty feed by another.

// A restaurant that has never set a radius (or saved 0 through the delivery form, which
// allows it) still needs a zone; leaving it at 0 would hide the store from everyone.
export const DEFAULT_DELIVERY_RADIUS_KM = 5;

// Platform ceiling. The owner form accepts up to 100 km, but food that travels further than
// this arrives cold and the rider's payout stops making sense, so no store's zone reaches
// past it however large a radius it saved. It also bounds the $geoNear candidate scan.
export const MAX_DELIVERY_RADIUS_KM = 15;

/**
 * The radius (km) actually enforced for a restaurant: its own setting, defaulted when unset
 * or non-positive, clamped to the platform ceiling.
 */
export const effectiveDeliveryRadiusKm = (delivery) => {
  const own = Number(delivery?.radiusKm);
  const radius = Number.isFinite(own) && own > 0 ? own : DEFAULT_DELIVERY_RADIUS_KM;
  return Math.min(radius, MAX_DELIVERY_RADIUS_KM);
};

// The same rule as an aggregation expression, so it can run inside Mongo against
// `$delivery.radiusKm` instead of pulling every candidate into Node to filter. Must stay in
// step with effectiveDeliveryRadiusKm above — delivery-zone.contract.test.js pins both.
export const EFFECTIVE_RADIUS_KM_EXPR = Object.freeze({
  $min: [
    {
      $cond: [
        { $gt: [{ $ifNull: ['$delivery.radiusKm', 0] }, 0] },
        '$delivery.radiusKm',
        DEFAULT_DELIVERY_RADIUS_KM,
      ],
    },
    MAX_DELIVERY_RADIUS_KM,
  ],
});
