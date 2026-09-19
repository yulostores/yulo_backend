// Address → coordinates, so an owner never has to type latitude/longitude by hand.
// Restaurant.location is a required 2dsphere GeoJSON point (every "restaurants near me"
// query in services/restaurant.service.js and home.service.js depends on it), but the
// only thing an owner actually knows is their street address — this service is the
// bridge between the two.
//
// Three providers, picked at call time, in this order:
//
//   1. HERE, when HERE_API_KEY is set. Preferred, and not just because it is the platform's
//      provider: the customer's delivery pin is reverse-geocoded by HERE too (see
//      services/places.service.js). Geocoding both ends of a delivery with the SAME provider is
//      what keeps `Restaurant.delivery.radiusKm` honest — two providers can place the same
//      address a few hundred metres apart, which is enough to make a restaurant appear in or
//      vanish from a customer's feed depending on who geocoded what.
//   2. Google, when only GOOGLE_MAPS_API_KEY is set. Legacy; kept so an existing deployment
//      configured that way does not silently change provider on deploy.
//   3. OpenStreetMap Nominatim, which needs no key or account. Its usage policy requires an
//      identifying User-Agent and caps callers at ~1 request/second — fine for restaurant
//      onboarding (a handful of calls a day), NOT fine on a per-order path.
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { geocodeQuery as geocodeWithHere } from './places.service.js';

const GEOCODE_TIMEOUT_MS = 5000;
const NOMINATIM_USER_AGENT = 'yulostores-platform/1.0 (restaurant onboarding geocoder)';

// Single-line query string for the geocoder, skipping the parts the owner left blank.
export const formatAddress = (address = {}) =>
  [address.street, address.city, address.state, address.pincode]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ');

const fetchJson = async (url, headers = {}) => {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
  });
  if (!res.ok) {
    logger.error({ status: res.status, host: new URL(url).host }, 'Geocoding request failed');
    return null;
  }
  return res.json().catch(() => null);
};

async function geocodeWithGoogle(query) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', env.GOOGLE_MAPS_API_KEY);

  const body = await fetchJson(url.toString());
  // Google reports "no match" as a 200 with status ZERO_RESULTS, so the status field
  // matters as much as the HTTP code.
  if (!body || body.status !== 'OK') {
    logger.warn({ status: body?.status, query }, 'Google geocoding returned no result');
    return null;
  }
  const { lat, lng } = body.results?.[0]?.geometry?.location ?? {};
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

async function geocodeWithNominatim(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const body = await fetchJson(url.toString(), {
    'User-Agent': NOMINATIM_USER_AGENT,
    'Accept-Language': 'en',
  });
  const hit = Array.isArray(body) ? body[0] : null;
  if (!hit) {
    logger.warn({ query }, 'Nominatim geocoding returned no result');
    return null;
  }
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

// Returns GeoJSON-order [longitude, latitude], or null when the address is empty,
// unresolvable, or the provider is unreachable. Never throws — callers decide whether a
// failed lookup blocks the write (creation does; a profile edit doesn't).
export async function geocodeAddress(address) {
  const query = formatAddress(address);
  if (!query) return null;

  try {
    if (env.HERE_API_KEY) {
      // A HERE miss falls through to Nominatim rather than returning null: an unresolvable
      // address blocks restaurant creation, so it is worth a second opinion before giving up.
      const hit = await geocodeWithHere(query);
      if (hit) return hit;
      logger.warn({ query }, 'HERE geocoding returned no result — falling back to Nominatim');
      return await geocodeWithNominatim(query);
    }
    return env.GOOGLE_MAPS_API_KEY
      ? await geocodeWithGoogle(query)
      : await geocodeWithNominatim(query);
  } catch (err) {
    logger.error({ err: err.message, query }, 'Geocoding lookup threw');
    return null;
  }
}

// A point a restaurant can actually be at: a finite [lng, lat] pair inside the valid ranges
// and not [0, 0]. "Null Island" is what every missing/failed location used to be defaulted
// to, so it is treated as "no location" rather than as a real address off the coast of
// Africa — a store there is invisible to every customer, and that is exactly how a
// Hazaribagh restaurant went missing.
export const isUsableCoordinatePair = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return false;
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return false;
  return !(lng === 0 && lat === 0);
};

// The map point for a restaurant being CREATED (owner sign-up or an admin adding a store):
// an explicit point when the caller genuinely has one, otherwise the address, geocoded.
// A failed lookup rejects the request instead of falling back to [0, 0] — see
// isUsableCoordinatePair. Shared so the owner portal and the admin console cannot disagree
// about it again (the admin path used to default silently).
export async function resolveRestaurantCoordinates({ address, coordinates }) {
  if (isUsableCoordinatePair(coordinates)) return coordinates;

  const geocoded = await geocodeAddress(address);
  if (!geocoded) {
    throw new ApiError(
      400,
      'ADDRESS_NOT_FOUND',
      "We couldn't locate that address on the map. Please check the street, city and pincode."
    );
  }
  return geocoded;
}
