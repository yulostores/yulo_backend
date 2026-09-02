// The one visibility rule every customer-facing restaurant surface applies.
//
// `isActive` alone was never enough. It defaults to true on Restaurant, so a store that
// had only just been created — never seen by an admin, approvalStatus "pending" — was
// already listed in nearby/search, readable by id, and serving a menu. The sharper case
// was the other end of the lifecycle: an admin suspending a live store changed nothing a
// customer could see, so a suspended restaurant stayed listed and orderable. Approval is
// enforced on the owner's side (middleware/requireRestaurantApproved.js); this is the
// matching rule for the read side.
//
// The two flags mean different things and both have to hold: `isActive` is the owner's
// own "we're on the platform" switch, `approvalStatus` is the platform's verdict.
export const PUBLIC_RESTAURANT_FILTER = Object.freeze({
  isActive: true,
  approvalStatus: 'active',
});

// Same rule against a document already in hand, for the paths that load the restaurant
// for other reasons anyway (order placement) rather than querying by filter.
export const isPubliclyVisible = (restaurant) =>
  restaurant?.isActive === true && restaurant?.approvalStatus === 'active';
