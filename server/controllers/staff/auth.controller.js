import argon2 from 'argon2';
import Restaurant from '../../models/Restaurant.js';
import StaffMember from '../../models/StaffMember.js';
import * as authService from '../../services/auth.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { escapeRegExp } from '../../utils/regex.js';
import { PUBLIC_RESTAURANT_FILTER } from '../../utils/publicRestaurant.js';

const SUGGESTION_LIMIT = 8;

// The staff login picker is the one public surface that lists restaurants by name for a
// non-customer. It stays narrow on purpose: a staff member needs the name, the town and
// a logo to tell two branches apart, and nothing else. Everything the customer-facing
// projection carries beyond that (contact details, delivery config, settings) would be
// handing store data to an unauthenticated caller for no UI benefit.
const SUGGESTION_FIELDS = {
  name: 1,
  logo: 1,
  coverImage: 1,
  cuisineTypes: 1,
  'address.street': 1,
  'address.city': 1,
  'address.state': 1,
};

// Prefix hits before substring hits, then alphabetical. Mongo cannot express this as a
// sort, and the candidate set is capped well below a page, so it is ordered here.
const rankByPrefix = (rows, term) => {
  const lower = term.toLowerCase();
  return rows
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.name.localeCompare(b.name);
    })
    .slice(0, SUGGESTION_LIMIT);
};

const toSuggestion = (r) => ({
  _id: r._id,
  name: r.name,
  logo: r.logo ?? null,
  coverImage: r.coverImage ?? null,
  cuisineTypes: r.cuisineTypes ?? [],
  address: {
    street: r.address?.street ?? null,
    city: r.address?.city ?? null,
    state: r.address?.state ?? null,
  },
  // Kilometres to one decimal — null when the caller sent no coordinates.
  distanceKm:
    typeof r.distanceMeters === 'number' ? Math.round(r.distanceMeters / 100) / 10 : null,
});

/**
 * GET /api/staff/auth/restaurants?q=&lat=&lng=
 *
 * Typeahead for the staff login screen. Public by necessity — a waiter holds no token
 * until they have picked their restaurant — so it is deliberately thin (see
 * SUGGESTION_FIELDS) and shows only restaurants a customer could already see.
 *
 * With coordinates the name match runs inside the $geoNear `query`, so results come back
 * ordered nearest-first and one character is usually enough to surface the branch the
 * staff member is standing in. Without coordinates (permission denied, desktop) it
 * degrades to a name-ranked list rather than failing.
 */
export const searchRestaurants = asyncHandler(async (req, res) => {
  const term = (req.query.q ?? '').trim();
  if (!term) return sendSuccess(res, 200, 'Restaurant suggestions', { restaurants: [] });

  const nameFilter = { ...PUBLIC_RESTAURANT_FILTER, name: new RegExp(escapeRegExp(term), 'i') };

  const lat = Number.parseFloat(req.query.lat);
  const lng = Number.parseFloat(req.query.lng);
  const hasCoords =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180;

  if (hasCoords) {
    // $geoNear has to be the first stage and already sorts ascending by distance, so no
    // $sort follows. No $maxDistance on purpose: a phone on a building wifi can be
    // geolocated tens of kilometres off, and a radius would hide the very restaurant the
    // staff member works at. Distance ranks this list, it does not gate it.
    const rows = await Restaurant.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          spherical: true,
          query: nameFilter,
        },
      },
      { $limit: SUGGESTION_LIMIT },
      { $project: { ...SUGGESTION_FIELDS, distanceMeters: 1 } },
    ]);
    return sendSuccess(res, 200, 'Restaurant suggestions', {
      restaurants: rows.map(toSuggestion),
      nearby: true,
    });
  }

  const rows = await Restaurant.find(nameFilter)
    .select(SUGGESTION_FIELDS)
    .limit(SUGGESTION_LIMIT * 3)
    .lean();

  sendSuccess(res, 200, 'Restaurant suggestions', {
    restaurants: rankByPrefix(rows, term).map(toSuggestion),
    nearby: false,
  });
});

// Verifying a throwaway hash when the staff code does not exist keeps the failed-login
// response time flat. Without it, "no such code" answers in a few milliseconds while a
// wrong PIN pays the full argon2 cost — a gap wide enough to enumerate a restaurant's
// staff codes from outside. Built once, lazily, so it costs nothing until a bad attempt.
let decoyHashPromise = null;
const decoyHash = () => {
  decoyHashPromise ??= argon2.hash('staff-login-decoy', { type: argon2.argon2id });
  return decoyHashPromise;
};

/**
 * POST /api/staff/auth/login  { restaurantId, staffCode, pin }
 *
 * The credentials are exactly what the owner created in the restaurant portal
 * (controllers/owner/staff.controller.js): the auto-assigned staffCode (W01, C02…) and
 * the PIN the owner set. There is no other way into this portal — no signup, no seeds.
 */
export const staffLogin = asyncHandler(async (req, res) => {
  const { restaurantId } = req.body;
  const staffCode = req.body.staffCode.replace(/\s+/g, '').toUpperCase();
  const pin = req.body.pin.trim();

  const restaurant = await Restaurant.findById(restaurantId)
    .select('name logo isActive approvalStatus')
    .lean();

  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  // A suspended or not-yet-approved store cannot take orders, so its staff must not be
  // able to open a shift either — every screen behind this login would render against
  // endpoints that reject them. This is the twin of middleware/requireRestaurantApproved
  // on the owner routes.
  if (!restaurant.isActive || restaurant.approvalStatus !== 'active') {
    throw new ApiError(
      403,
      'RESTAURANT_UNAVAILABLE',
      'This restaurant is not currently active. Please contact your manager.'
    );
  }

  // O(1) — the { restaurantId, staffCode } unique index answers this directly.
  const staff = await StaffMember.findOne({ restaurantId, staffCode });

  // A deactivated member is indistinguishable from wrong credentials on purpose: someone
  // who has been let go should not learn that their code is still on file.
  if (!staff || !staff.isActive) {
    await argon2.verify(await decoyHash(), pin).catch(() => false);
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid staff code or PIN');
  }

  const valid = await argon2.verify(staff.pinHash, pin);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid staff code or PIN');

  const staffToken = authService.generateStaffToken(staff._id, staff.role, staff.restaurantId);

  sendSuccess(res, 200, 'Login successful', {
    staffToken,
    staff: {
      _id: staff._id,
      name: staff.name,
      role: staff.role,
      staffCode: staff.staffCode,
      restaurantId: staff.restaurantId,
      restaurantName: restaurant.name,
      restaurantLogo: restaurant.logo ?? null,
    },
  });
});

/**
 * GET /api/staff/auth/me
 *
 * The staff token lives in localStorage so a shift survives a phone locking itself, which
 * means the browser can hold a token for a member who has since been deactivated or whose
 * restaurant was suspended. The portal calls this on boot and trusts the answer rather
 * than the cached profile.
 */
export const staffSession = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.staff.restaurantId)
    .select('name logo isActive approvalStatus')
    .lean();

  if (!restaurant || !restaurant.isActive || restaurant.approvalStatus !== 'active') {
    throw new ApiError(
      403,
      'RESTAURANT_UNAVAILABLE',
      'This restaurant is not currently active. Please contact your manager.'
    );
  }

  const staff = await StaffMember.findById(req.staff._id).select('-pinHash').lean();

  sendSuccess(res, 200, 'Staff session', {
    staff: {
      _id: staff._id,
      name: staff.name,
      role: staff.role,
      staffCode: staff.staffCode,
      restaurantId: staff.restaurantId,
      restaurantName: restaurant.name,
      restaurantLogo: restaurant.logo ?? null,
    },
  });
});

export const staffLogout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    await authService.blacklistToken(header.slice(7));
  }
  sendSuccess(res, 200, 'Logged out', null);
});
