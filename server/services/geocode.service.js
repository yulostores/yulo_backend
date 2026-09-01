// Address → coordinates, so an owner never has to type latitude/longitude by hand.
// Restaurant.location is a required 2dsphere GeoJSON point (every "restaurants near me"
// query in services/restaurant.service.js and home.service.js depends on it), but the
// only thing an owner actually knows is their street address — this service is the
// bridge between the two.
//
// Two providers, picked at call time: Google Geocoding when GOOGLE_MAPS_API_KEY is set
// (README already documents that key as the platform's maps key), otherwise
// OpenStreetMap's Nominatim, which needs no key or account. Nominatim's usage policy
// requires an identifying User-Agent and caps callers at ~1 request/second — fine for
// restaurant onboarding (a handful of calls a day), NOT fine if this ever moves onto a
// per-order path, which is when the Google key should be filled in.
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

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
    return env.GOOGLE_MAPS_API_KEY
      ? await geocodeWithGoogle(query)
      : await geocodeWithNominatim(query);
  } catch (err) {
    logger.error({ err: err.message, query }, 'Geocoding lookup threw');
    return null;
  }
}
