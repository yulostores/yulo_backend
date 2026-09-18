// Address autocomplete and reverse geocoding for the customer app's location flow, via the HERE
// Geocoding & Search API v7.
//
// See here.service.js for why this is a server proxy even though the app already carries a HERE
// key for map tiles: caching, one place to enforce India-only results, and — most usefully —
// one address-normalisation path shared with services/geocode.service.js, so a restaurant's pin
// and a customer's pin are never produced by two providers that disagree about where a place is.
//
// Unlike Google's Places API there is no session-token billing model to work around here: HERE
// bills autosuggest per request, so the caller's job is simply to debounce, which the app does.
// The happy consequence is that HERE returns coordinates inline with each suggestion, so a
// chosen row needs no second lookup before a pin can drop.

import { callHere, HERE_HOSTS, isHereEnabled, toHerePoint } from './here.service.js';

// Every restaurant and rider on this platform is in India; biasing is not enough, because an
// unrestricted search for "Sector 18" happily returns results on other continents.
const COUNTRY = 'countryCode:IND';

const SUGGESTION_LIMIT = 6;

// Autosuggest result types that are query REFINEMENTS rather than places — "show me all Domino's",
// "show me all cafes". They carry no position, so a row built from one would be a suggestion that
// cannot become a pin. Filtered out rather than rendered and then failing on tap.
const NON_PLACE_RESULT_TYPES = new Set(['chainQuery', 'categoryQuery']);

/**
 * HERE's address object → the flat shape the app's address form and the Order model both use.
 *
 * `district` before `city` matters in Indian addressing: for a Delhi address the city is
 * "New Delhi", but what a customer recognises and navigates by is "Saket".
 */
function toAddressParts(address = {}) {
  const street = [address.houseNumber, address.street].filter(Boolean).join(' ') || address.street;

  return {
    street: street || undefined,
    district: address.district || address.subdistrict || undefined,
    city: address.city || address.county || undefined,
    region: address.state || undefined,
    pincode: address.postalCode || undefined,
    country: address.countryName || undefined,
  };
}

/** HERE `{lat, lng}` → this codebase's GeoJSON `[lng, lat]`. */
const toGeoJSON = (position) =>
  position && Number.isFinite(position.lat) && Number.isFinite(position.lng)
    ? [position.lng, position.lat]
    : null;

/**
 * Builds the two display lines a suggestion row renders, without repeating itself.
 *
 * HERE's `address.label` is the full formatted address and normally starts with the same text as
 * `title`, so using both verbatim produces rows that read "Saket Metro Station, Saket Metro
 * Station, New Delhi…". Stripping the duplicated head is what makes the list scannable.
 */
function toDisplayLines(item) {
  const primary = item.title ?? item.address?.label ?? 'Unnamed place';
  const label = item.address?.label ?? '';

  const secondary = label.startsWith(primary)
    ? label.slice(primary.length).replace(/^[,\s]+/, '')
    : label;

  return { primary, secondary };
}

/**
 * Typeahead suggestions for `query`, biased around `near`.
 *
 * Returns `[]` for a query under three characters and for any failure — the search box shows its
 * empty state either way, and a dead geocoder must never block the address flow.
 *
 * `near` is REQUIRED by HERE's autosuggest endpoint (it has no unanchored mode), so callers pass
 * the map centre or a sensible default rather than omitting it.
 */
export async function autocomplete(query, { near } = {}) {
  if (!isHereEnabled() || !query || query.trim().length < 3) return [];

  const at = toHerePoint(near);
  if (!at) return [];

  const body = await callHere(HERE_HOSTS.autosuggest, 'v1/autosuggest', {
    q: query.trim(),
    at,
    in: COUNTRY,
    limit: SUGGESTION_LIMIT,
    lang: 'en-US',
  });

  if (!Array.isArray(body?.items)) return [];

  return body.items
    .filter((item) => !NON_PLACE_RESULT_TYPES.has(item.resultType))
    .map((item) => {
      const coordinates = toGeoJSON(item.position);
      if (!coordinates) return null;
      const { primary, secondary } = toDisplayLines(item);
      return { id: item.id, primary, secondary, coordinates, ...toAddressParts(item.address) };
    })
    .filter(Boolean);
}

/**
 * Coordinates → a human address, for the drag-to-pin map.
 *
 * Returns null when HERE has nothing or the call fails, and the app falls back to the on-device
 * geocoder. HERE is tried first because the device geocoder is noticeably worse at Indian
 * addresses — it routinely answers a precise pin with a bare pincode or a road two blocks away,
 * which is what makes a drag-to-pin flow feel untrustworthy.
 */
export async function reverseGeocode(coordinates) {
  if (!isHereEnabled()) return null;

  const at = toHerePoint(coordinates);
  if (!at) return null;

  const body = await callHere(HERE_HOSTS.revgeocode, 'v1/revgeocode', {
    at,
    // HERE orders results most-specific first, so one is enough — asking for more just buys the
    // enclosing locality and postcode areas we would discard.
    limit: 1,
    lang: 'en-US',
  });

  const hit = body?.items?.[0];
  if (!hit) return null;

  const parts = toAddressParts(hit.address);
  const title = hit.title ?? parts.street ?? parts.district ?? parts.city ?? 'Dropped pin';
  const subtitle = [
    parts.district && parts.district !== title ? parts.district : null,
    parts.city,
    parts.region,
    parts.pincode,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    title,
    subtitle: subtitle || hit.address?.label || '',
    coordinates,
    ...parts,
  };
}

/**
 * Free-text address → coordinates, for server-side geocoding of restaurant addresses.
 * See services/geocode.service.js, which prefers this over its keyless fallbacks so that
 * restaurant pins and customer pins come from the same provider.
 */
export async function geocodeQuery(query) {
  if (!isHereEnabled() || !query) return null;

  const body = await callHere(HERE_HOSTS.geocode, 'v1/geocode', {
    q: query,
    in: COUNTRY,
    limit: 1,
    lang: 'en-US',
  });

  return toGeoJSON(body?.items?.[0]?.position);
}
