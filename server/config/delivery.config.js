// How far a customer can SEE, and how far a restaurant's food actually TRAVELS.
//
// These are two different questions and they used to be answered by one number, which is
// what made newly-added restaurants invisible:
//
//   * DISCOVERY — "which restaurants appear in my app at all". Platform-wide, one radius for
//     everybody, the thing the customer means by "restaurants near me".
//   * DELIVERY  — "can this particular restaurant bring food to my pin". Per restaurant
//     (Restaurant.delivery.radiusKm), the thing that decides whether the card is orderable.
//
// Before this split, the list WAS the delivery check: a restaurant only appeared if the
// customer was inside its own radius. Since `delivery.radiusKm` is optional on every form
// that creates a restaurant (owner sign-up, the admin console's Add Store), every new store
// fell back to the 5 km default and vanished for anyone further out — with nothing anywhere
// to say why. Discovery is now its own radius, and the per-restaurant zone only decides
// whether the card says "delivers here", never whether it is listed.

// The customer's browse radius: every live restaurant within this many kilometres is listed,
// nearest first. Also bounds the $geoNear candidate scan.
export const DISCOVERY_RADIUS_KM = 25;

// A restaurant that has never opened the delivery form serves the whole discovery area.
// "Unset" means the owner has not restricted their reach — not "5 km", which is a
// restriction nobody chose and which silently hid the store from most of its own city.
export const DEFAULT_DELIVERY_RADIUS_KM = DISCOVERY_RADIUS_KM;

// Platform ceiling on a restaurant's own zone. The owner form accepts up to 100 km; food
// that travels further than this arrives cold and the rider's payout stops making sense, so
// no store's zone reaches past it however large a radius it saved. Kept equal to the
// discovery radius so "listed" and "deliverable" can never disagree at the outer edge.
export const MAX_DELIVERY_RADIUS_KM = DISCOVERY_RADIUS_KM;

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

// How far from a RESTAURANT we look for a rider to offer a pickup to. A platform policy,
// not a restaurant setting: it is about how far a rider will ride to collect an order, which
// has nothing to do with how far that restaurant is willing to send food afterwards.
//
// It used to be `restaurant.delivery.radiusKm ?? 5`, which had two problems. A restaurant
// that saved a radius of 0 — the delivery form allows it — searched a zero-metre circle and
// found no nearby rider at all, falling through to the rating-ranked fallback list of every
// partner on the platform regardless of where they were. And now that an unset radius means
// the full 25 km discovery area, reusing it here would start offering pickups to riders
// 25 km from the kitchen.
export const PARTNER_PICKUP_SEARCH_RADIUS_KM = 7;

// "Does THIS restaurant deliver to the pin?" as an aggregation expression, against the
// `distanceMeters` $geoNear writes. Returned on every listed restaurant as `deliversToPin`
// so a card can say "too far to deliver" instead of the restaurant simply not existing.
export const DELIVERS_TO_PIN_EXPR = Object.freeze({
  $lte: ['$distanceMeters', { $multiply: [EFFECTIVE_RADIUS_KM_EXPR, 1000] }],
});
