import Restaurant from '../../models/Restaurant.js';
import StaffMember from '../../models/StaffMember.js';
import * as authService from '../../services/auth.service.js';
import * as otpService from '../../services/otp.service.js';
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

// Where the member's OTP lives — its own namespace per restaurant (see otp.service.js), so a
// customer or partner code for the same number can never finish a staff login, nor a code
// requested at one restaurant sign the number in at another.
const staffOtpScope = (restaurantId) => `staff:${restaurantId}`;

const assertRestaurantOpenForStaff = async (restaurantId) => {
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
  return restaurant;
};

const findSignInableStaff = (restaurantId, phone) =>
  StaffMember.findOne({ restaurantId, phone, isActive: true });

/**
 * POST /api/staff/auth/otp/send  { restaurantId, phone }
 *
 * Staff sign in with an OTP sent to the phone the owner registered for them
 * (controllers/owner/staff.controller.js). The answer is the same whether or not the
 * number belongs to an active member here — otherwise this endpoint would tell anyone who
 * works where — and a code is only actually requested (an SMS spent) when it does.
 */
export const sendStaffOtp = asyncHandler(async (req, res) => {
  const { restaurantId, phone } = req.body;
  await assertRestaurantOpenForStaff(restaurantId);

  const staff = await findSignInableStaff(restaurantId, phone);
  // Every number spends its send budget the same way (and gets the same 429 on the 4th
  // try), but only a member's number actually gets a code stored and an SMS sent. A
  // non-member's verify then fails as OTP_EXPIRED, since nothing was stored for it.
  const result = await otpService.requestOtp(phone, {
    scope: staffOtpScope(restaurantId),
    send: Boolean(staff),
  });

  sendSuccess(res, 200, 'If this number is registered for this restaurant, a code has been sent', {
    phone: result.phone,
    ...(result.otpBypass ? { otpBypass: true } : {}),
    // Dev only (SMS_PROVIDER=mock outside production) — see otp.service.js.
    ...(result.devOtp ? { devOtp: result.devOtp } : {}),
  });
});

/**
 * POST /api/staff/auth/otp/verify  { restaurantId, phone, code }
 *
 * Returns a staff token good for exactly 24 hours (services/auth.service.js) — there is no
 * refresh; the member signs in again the next day.
 */
export const verifyStaffOtp = asyncHandler(async (req, res) => {
  const { restaurantId, phone, code } = req.body;
  const restaurant = await assertRestaurantOpenForStaff(restaurantId);

  // Throws OTP_EXPIRED / INVALID_OTP / OTP_LOCKED. A number that isn't staff here never had
  // a code stored, so it fails as OTP_EXPIRED — the same as a member who never asked.
  await otpService.verifyOtp(phone, code, { scope: staffOtpScope(restaurantId) });

  // Re-read after the code checks out: the owner may have deactivated the member, or moved
  // the number to someone else, in the minutes since the code was sent.
  const staff = await findSignInableStaff(restaurantId, phone);
  if (!staff) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'This number is not registered as staff here');
  }

  const staffToken = authService.generateStaffToken(
    staff._id,
    staff.role,
    staff.restaurantId,
    staff.sessionVersion ?? 0
  );

  sendSuccess(res, 200, 'Login successful', {
    staffToken,
    expiresAt: new Date(Date.now() + authService.STAFF_SESSION_SECONDS * 1000).toISOString(),
    // The same moment as seconds from now. A restaurant tablet's clock is often wrong, so
    // the portal counts down from this rather than comparing expiresAt with its own clock.
    expiresInSeconds: authService.STAFF_SESSION_SECONDS,
    staff: toStaffProfile(staff, restaurant),
  });
});

const toStaffProfile = (staff, restaurant) => ({
  _id: staff._id,
  name: staff.name,
  role: staff.role,
  staffCode: staff.staffCode,
  phone: staff.phone ?? null,
  restaurantId: staff.restaurantId,
  restaurantName: restaurant.name,
  restaurantLogo: restaurant.logo ?? null,
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

  const staff = await StaffMember.findById(req.staff._id).lean();
  // Removed between authenticateStaff's lookup and this one.
  if (!staff) throw new ApiError(401, 'INVALID_TOKEN', 'Staff member not found');

  sendSuccess(res, 200, 'Staff session', {
    staff: toStaffProfile(staff, restaurant),
    // When this session ends (24h after sign-in), so the portal can say so — as a time,
    // and as seconds from now for a device whose clock can't be trusted.
    expiresAt: req.staff.tokenExpiresAt ?? null,
    expiresInSeconds: req.staff.tokenExpiresAt
      ? Math.max(0, Math.round((new Date(req.staff.tokenExpiresAt).getTime() - Date.now()) / 1000))
      : null,
  });
});

export const staffLogout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    await authService.blacklistToken(header.slice(7));
  }
  sendSuccess(res, 200, 'Logged out', null);
});
