// The one place a customer delivery address is shaped, validated and located.
//
// Before this file, `POST/PATCH /api/users/me/addresses` took `req.body` and handed it
// straight to a Mongoose subdocument. Three things went wrong as a result, all of them
// downstream of a write nobody checked:
//
//   1. Coordinates were trusted verbatim. Nothing rejected [0, 0], nothing caught a client
//      that sent [lat, lng] instead of GeoJSON's [lng, lat], and nothing noticed a pair of
//      strings. A swapped pair is the nastiest of the three because it is a perfectly valid
//      point — just in the wrong hemisphere — so it fails silently, forever.
//   2. A failed geocode persisted `location: { type: 'Point', coordinates: [] }` (the schema
//      default filling in around an absent value). That is not "no location": it is truthy,
//      it has a `type`, and every consumer treated it as real. The customer app read it as
//      `{ latitude: undefined }` and stopped loading the home feed entirely; the order
//      snapshot carried `[]` into computeDropKm, which returned NaN into the rider's
//      distance pay.
//   3. The detail the customer typed — flat number, floor, landmark — was joined into one
//      `street` string by the app before it was ever sent, so it could not be edited,
//      re-displayed, or handed to a rider as separate lines.
//
// Everything here is ordinary and boring on purpose: validate, normalise, geocode when
// there is nothing better, compose the display line. It is shared by add and update so the
// two cannot drift.
import { z } from 'zod';
import { geocodeAddress, isUsableCoordinatePair } from './geocode.service.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// The postal parts. Changing any of these is what makes a stored point stale — see
// `postalPartsChanged` below, which is the difference between "re-geocode this address"
// and "the customer edited the receiver's phone number, leave their pin alone".
export const POSTAL_FIELDS = Object.freeze([
  'houseNumber',
  'floor',
  'building',
  'landmark',
  'area',
  'street',
  'city',
  'state',
  'pincode',
  'country',
]);

const trimmed = (max) => z.string().trim().max(max);
const optionalText = (max) => trimmed(max).optional().nullable();

// Bounding box of India, the only country this platform serves (six-digit pincodes, ₹,
// ten-digit phone numbers, a HERE geocoder pinned to `in`). Generous enough to include the
// Andamans and Ladakh.
//
// It exists to catch ONE specific mistake, which per-axis range checks cannot: a client
// sending [latitude, longitude] instead of GeoJSON's [longitude, latitude]. Anywhere in
// India, both halves of the pair are individually valid either way round — Ranchi is
// [85.36, 23.99] and the reversed [23.99, 85.36] is a perfectly legal point in the Arctic
// Ocean — so a swap is accepted, stored, and then silently wrong forever. Everything
// downstream (the rider's distance pay, the ETA, which partners are offered the order)
// quietly computes from a delivery address several thousand kilometres away.
const INDIA_BBOX = Object.freeze({ minLng: 68, maxLng: 98, minLat: 6, maxLat: 38 });

const insideIndia = ([lng, lat]) =>
  lng >= INDIA_BBOX.minLng &&
  lng <= INDIA_BBOX.maxLng &&
  lat >= INDIA_BBOX.minLat &&
  lat <= INDIA_BBOX.maxLat;

// GeoJSON order, [longitude, latitude] — the order every coordinates field in this codebase
// uses.
const coordinatesSchema = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine((pair) => isUsableCoordinatePair(pair), {
    message: 'coordinates must be a real point (GeoJSON order, [longitude, latitude], not [0, 0])',
  })
  .refine((pair) => insideIndia(pair) || !insideIndia([pair[1], pair[0]]), {
    // Named explicitly, because "coordinates out of range" sends whoever hits this looking
    // for a bad GPS reading rather than for a reversed tuple.
    message:
      'coordinates look reversed — send GeoJSON order [longitude, latitude], not [latitude, longitude]',
  })
  .refine(insideIndia, {
    message: 'coordinates are outside the area this platform serves',
  });

const locationSchema = z.object({
  type: z.literal('Point').optional(),
  coordinates: coordinatesSchema,
});

const baseAddressSchema = z.object({
  label: z.enum(['home', 'work', 'other']).optional(),
  customLabel: optionalText(40),

  houseNumber: optionalText(120),
  floor: optionalText(40),
  building: optionalText(160),
  landmark: optionalText(160),

  area: optionalText(160),
  street: optionalText(240),
  city: optionalText(80),
  state: optionalText(80),
  pincode: optionalText(12),
  country: optionalText(80),
  formattedAddress: optionalText(400),

  location: locationSchema.optional(),
  locationSource: z.enum(['device', 'map_pin', 'geocoded', 'unknown']).optional(),

  contactName: optionalText(60),
  contactPhone: optionalText(20),
  isDefault: z.boolean().optional(),
});

// Create requires enough to be able to find the place at all. An address with neither a
// point nor a city is not an address — it used to be accepted and then quietly excluded
// from every distance calculation for the life of the account.
export const createAddressSchema = baseAddressSchema.refine(
  (a) => Boolean(a.location) || Boolean(a.pincode?.trim()) || Boolean(a.city?.trim()),
  { message: 'An address needs either a map point or at least a city / pincode' }
);

// Update is a patch: every field optional, nothing implied by absence.
export const updateAddressSchema = baseAddressSchema;

export const parseAddressInput = (body, { partial = false } = {}) => {
  const schema = partial ? updateAddressSchema : createAddressSchema;
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid address', result.error.flatten());
  }
  // Drop keys the caller didn't send, so a patch never overwrites a stored value with
  // `undefined` via Object.assign.
  return Object.fromEntries(Object.entries(result.data).filter(([, v]) => v !== undefined));
};

/**
 * The one-line `street` every existing screen, order snapshot and older app build reads,
 * composed from the parts. Kept as a real stored field rather than a virtual because it is
 * snapshotted onto Order.deliveryAddress at placement and has to survive there unchanged.
 *
 * Order matters and matches how the line is read aloud at a door: flat, building, floor,
 * landmark, then the street itself.
 */
export const composeStreetLine = (address = {}) => {
  const parts = [
    address.houseNumber,
    address.building,
    address.floor ? `Floor ${String(address.floor).trim()}` : null,
    address.landmark,
    address.street,
  ]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean);

  // De-duplicate case-insensitively: the landmark a customer types is very often already
  // part of the geocoded street line, and "Near City Mall, Near City Mall" reads as a bug.
  const seen = new Set();
  const unique = parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.join(', ') || undefined;
};

/** Single-line address for a geocoder query — the postal parts only, never the flat number. */
const geocodableLine = (address = {}) =>
  [address.street, address.area, address.city, address.state, address.pincode]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ');

/**
 * Did this patch actually MOVE the address?
 *
 * The distinction the old code missed. It re-geocoded whenever a postal key was *present*
 * in the patch, and the app's edit screen posts all of them on every save — so changing the
 * receiver's phone number silently replaced the pin the customer had dragged on the map
 * with whatever a geocoder made of the text line. Compare values, not key presence.
 */
export const postalPartsChanged = (existing, patch) =>
  POSTAL_FIELDS.some(
    (field) =>
      field in patch &&
      String(patch[field] ?? '').trim() !== String(existing?.[field] ?? '').trim()
  );

/**
 * A `location` value safe to store: a real GeoJSON point, or `undefined` so the field stays
 * absent. Never `{ type: 'Point', coordinates: [] }` — see this file's header for what that
 * shape cost.
 */
export const normalizeLocation = (location) =>
  isUsableCoordinatePair(location?.coordinates)
    ? { type: 'Point', coordinates: location.coordinates }
    : undefined;

/**
 * Fill in everything the customer didn't have to type: the composed street line, and a map
 * point when none came with the request.
 *
 * A device/map fix always wins — it is the customer pointing at their own front door, and
 * no geocoder can beat that. A lookup only runs when there is nothing better, and a failed
 * one leaves the address without coordinates rather than blocking the save: a customer must
 * still be able to keep an address the geocoder has never heard of. The distance-based
 * features degrade honestly for it, which is the point — the app used to substitute a city
 * centre instead, which made every one of those numbers quietly wrong.
 *
 * @param base   the address as it already exists (empty on create)
 * @param patch  the fields being written, so only what the caller is changing is touched
 * @param options.geocode  run a lookup when there is no usable point (default true)
 */
export const resolveAddress = async (base, patch = {}, { geocode = true } = {}) => {
  const merged = { ...base, ...patch };
  const out = { ...patch };

  // A point that came WITH this request, as opposed to one already on the document. Only
  // the former may overwrite; the latter must be left strictly alone, key and all, so a
  // save that touches nothing geographic cannot rewrite the customer's dragged pin.
  // (`'location' in patch` implies it is valid — the zod schema above rejected it otherwise.)
  const supplied = 'location' in patch ? normalizeLocation(patch.location) : undefined;

  if (supplied) {
    out.location = supplied;
    out.locationSource = patch.locationSource ?? 'map_pin';
  } else if (geocode) {
    const query = geocodableLine(merged);
    const coordinates = query ? await geocodeAddress(merged) : null;
    if (coordinates) {
      out.location = { type: 'Point', coordinates };
      out.locationSource = 'geocoded';
    } else {
      // Explicit `undefined` rather than leaving the key out: on an edit that moved the
      // address, the OLD point must not survive under the new street.
      out.location = undefined;
      out.locationSource = 'unknown';
      logger.warn({ query }, 'Saved address has no usable location — distance features degraded');
    }
  }

  const street = composeStreetLine(merged);
  if (street !== undefined) out.street = street;

  return out;
};
