import Restaurant from '../models/Restaurant.js';

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

// Fields that must never leave on a customer-facing read. Every public surface below
// returns the whole Restaurant document, so anything added to the schema is exposed by
// default — and `documents` now holds the URLs of the owner's scanned FSSAI licence, PAN
// card and bank statement (see controllers/owner/document.controller.js), which no
// customer has any business fetching. `adminNotes` is the platform's internal review
// commentary about the store, for the same reason. `payoutAccount` is the restaurant's bank
// account (holder, IFSC, last 4 digits and the encrypted number) — `select: false` on parts of
// it does nothing inside an aggregation, so it is listed here explicitly.
//
// Applied with `.select()` on the queries that return full documents; the surfaces that
// already project a narrow field list (search typeahead) don't need it. Aggregation
// pipelines (the nearby query) can't take the `.select()` string, so the field list is kept
// here once and both forms are derived from it.
export const PUBLIC_RESTAURANT_HIDDEN_FIELDS = Object.freeze(['documents', 'adminNotes', 'payoutAccount']);

// The `.select()` form. A field with a `select: false` child (payoutAccount.accountNumberEncrypted)
// can't be excluded whole — Mongoose adds its own exclusion of that child and the two collide
// ("Path collision at payoutAccount.accountNumberEncrypted") — so such a field is excluded child
// by child instead, read off the schema so a sub-field added later is hidden too. The aggregation
// `$unset` above has no such problem and removes the whole field.
const hasHiddenChild = (field) =>
  Object.values(Restaurant.schema.paths).some((p) => p.path.startsWith(`${field}.`) && p.options?.select === false);
const exclusionsFor = (field) =>
  hasHiddenChild(field)
    ? Object.values(Restaurant.schema.paths)
        .filter((p) => p.path.startsWith(`${field}.`) && p.options?.select !== false)
        .map((p) => `-${p.path}`)
    : [`-${field}`];
export const PUBLIC_RESTAURANT_PROJECTION = PUBLIC_RESTAURANT_HIDDEN_FIELDS.flatMap(exclusionsFor).join(' ');
