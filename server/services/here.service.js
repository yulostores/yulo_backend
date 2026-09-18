// Low-level client for the HERE Location Services REST APIs (Routing v8, Geocoding & Search v7).
//
// Everything HERE-flavoured on the server funnels through here so there is exactly one place that
// knows the key, the timeout and the error handling. Callers get plain data back and never see an
// HTTP detail.
//
// THE APP ALREADY HAS A HERE KEY, SO WHY PROXY THROUGH THE SERVER AT ALL?
// Because the tiles and the REST APIs want different things from it. A map-tile key has to be in
// the app — there is no other way for the renderer to authenticate — and it is protected by the
// usage restrictions set on the HERE portal. Routing is different: it is billed per transaction
// and it is worth CACHING, and a cache only helps if every customer watching the same delivery
// shares it. Search is different again: routing it through here means the customer's address
// picker and the restaurant geocoder (services/geocode.service.js) normalise addresses through
// exactly the same code, so a restaurant's pin and a customer's pin can be compared without two
// providers quietly disagreeing about where a place is.
//
// Unset key → every export degrades to null rather than throwing, and each caller falls back to
// what the platform did before (haversine distance, Nominatim). The app never breaks because a
// key lapsed.

import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const HERE_TIMEOUT_MS = 6000;

/** True when a key is configured. Callers branch on this to pick their fallback path. */
export const isHereEnabled = () => Boolean(env.HERE_API_KEY);

/**
 * Calls one HERE endpoint and returns its parsed body, or null when the call failed.
 *
 * `host` is the per-API subdomain — HERE splits its services across hosts (router., autosuggest.,
 * revgeocode.) rather than pathing off one origin, so it cannot be baked in here.
 *
 * `params` values that are null/undefined/'' are dropped, so callers can pass optional biasing
 * parameters without guarding each one.
 */
export async function callHere(host, path, params = {}) {
  if (!isHereEnabled()) return null;

  const url = new URL(`https://${host}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('apiKey', env.HERE_API_KEY);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(HERE_TIMEOUT_MS) });
    if (!res.ok) {
      // HERE puts the useful detail in the body, not the status line — a 400 from Routing will
      // say "no route found" vs "invalid transportMode", and without this you are guessing.
      const detail = await res.text().catch(() => '');
      logger.error({ status: res.status, host, path, detail: detail.slice(0, 300) }, 'HERE request failed');
      return null;
    }
    return await res.json();
  } catch (err) {
    // Timeouts surface as an AbortError; treat both the same — the caller has a fallback.
    logger.error({ err: err.message, host, path }, 'HERE request threw');
    return null;
  }
}

// HERE's service hosts, named so callers read as prose rather than as string literals.
export const HERE_HOSTS = {
  routing: 'router.hereapi.com',
  autosuggest: 'autosuggest.search.hereapi.com',
  revgeocode: 'revgeocode.search.hereapi.com',
  geocode: 'geocode.search.hereapi.com',
};

/** `[lng, lat]` (this codebase's GeoJSON order) → `"lat,lng"` (HERE's order). */
export const toHerePoint = (coordinates) =>
  Array.isArray(coordinates) && coordinates.length === 2 ? `${coordinates[1]},${coordinates[0]}` : null;
