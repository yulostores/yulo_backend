import Restaurant from '../../models/Restaurant.js';
import * as cacheService from '../../services/cache.service.js';
import { geocodeAddress, isUsableCoordinatePair, resolveRestaurantCoordinates } from '../../services/geocode.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateCreateRestaurant, validateStoreSettingsChanges } from '../../config/storeSettings.config.js';

export const createRestaurant = asyncHandler(async (req, res) => {
  const { name, description, cuisineTypes, address, location } = req.body;

  // Same field contract the store-settings form is held to (config/storeSettings.config.js),
  // narrowed to what this endpoint accepts — creating a restaurant is the first half of
  // filling that form in, so the two shouldn't disagree about what a complete address is.
  const fieldErrors = validateCreateRestaurant({ name, address });
  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Some required details are missing or invalid',
      { fieldErrors }
    );
  }

  // Owners submit an address, not coordinates. `location.coordinates` is still honoured
  // when a caller genuinely has a point (admin tooling, a future map picker, imports) —
  // otherwise the address is geocoded, and a failed lookup rejects the request rather than
  // falling back to [0, 0] (see resolveRestaurantCoordinates).
  const coords = await resolveRestaurantCoordinates({
    address,
    coordinates: location?.coordinates,
  });

  const restaurant = await Restaurant.create({
    ownerId: req.user._id,
    name,
    description,
    cuisineTypes: cuisineTypes || [],
    address: address || {},
    location: { type: 'Point', coordinates: coords },
  });

  sendSuccess(res, 201, 'Restaurant created', { restaurant });
});

export const listMyRestaurants = asyncHandler(async (req, res) => {
  const restaurants = await Restaurant.find({ ownerId: req.user._id }).lean();
  sendSuccess(res, 200, 'Your restaurants', { restaurants });
});

export const getRestaurant = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Restaurant', { restaurant: req.restaurant });
});

const ADDRESS_KEYS = ['street', 'city', 'state', 'pincode'];
const PROFILE_PATHS = ['name', 'description', 'cuisineTypes', ...ADDRESS_KEYS.map((k) => `address.${k}`)];
const BOOLEAN_KEYS = ['isActive', 'isPureVeg', 'vegFleetAvailable'];
const BADGES_MAX = 10;
const BADGE_MAX_LENGTH = 40;

export const updateRestaurant = asyncHandler(async (req, res) => {
  const allowed = [
    'name',
    'description',
    'cuisineTypes',
    'address',
    'location',
    ...BOOLEAN_KEYS,
    'badges',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // The same field rules as the store-settings form (PATCH /settings), applied to what this
  // save changes. This route used to write whatever it was sent: an empty-string-free but
  // otherwise unchecked name, a description of any length, cuisines of any size.
  for (const key of BOOLEAN_KEYS) {
    if (updates[key] !== undefined && typeof updates[key] !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', `${key} must be true or false`);
    }
  }
  if (
    updates.badges !== undefined &&
    (!Array.isArray(updates.badges) ||
      updates.badges.length > BADGES_MAX ||
      updates.badges.some((b) => typeof b !== 'string' || !b.trim() || b.length > BADGE_MAX_LENGTH))
  ) {
    throw new ApiError(400, 'VALIDATION_ERROR', `badges must be up to ${BADGES_MAX} short labels`);
  }
  if (updates.address !== undefined && (typeof updates.address !== 'object' || updates.address === null || Array.isArray(updates.address))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'address must be an object');
  }

  const existing = req.restaurant.toObject();
  const existingAddress = existing.address && typeof existing.address === 'object' ? existing.address : {};
  // An address is merged into the one on file, not swapped for it: { address: { pincode } }
  // used to replace the whole object, dropping the street, city and state — and the
  // re-geocode of that lone PIN code then moved the restaurant's map point to another city.
  const mergedAddress = { ...existingAddress };
  for (const key of ADDRESS_KEYS) {
    if (updates.address?.[key] !== undefined) mergedAddress[key] = updates.address[key];
  }
  const before = { ...existing, address: existingAddress };
  const after = {
    ...before,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.description !== undefined && { description: updates.description }),
    ...(updates.cuisineTypes !== undefined && { cuisineTypes: updates.cuisineTypes }),
    address: mergedAddress,
  };
  // Only what this save changes: a detail missing elsewhere is the settings form's to
  // demand, and must not stop the owner dropping their map pin.
  const fieldErrors = validateStoreSettingsChanges(before, after, { paths: PROFILE_PATHS, onlyChanged: true });
  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Some details are missing or invalid', { fieldErrors });
  }

  const addressChanged = ADDRESS_KEYS.some(
    (key) => String(mergedAddress[key] ?? '').trim() !== String(existingAddress[key] ?? '').trim()
  );
  if (updates.address !== undefined) {
    delete updates.address;
    if (typeof existing.address === 'string' || !existing.address) {
      // A legacy stringified (or missing) address can't be reached with dot-notation.
      updates.address = Object.fromEntries(ADDRESS_KEYS.map((key) => [key, mergedAddress[key] ?? '']));
    } else {
      for (const key of ADDRESS_KEYS) {
        if (req.body.address[key] !== undefined) updates[`address.${key}`] = mergedAddress[key];
      }
    }
  }

  // An explicit point — the owner's "Use my current location" in store settings. Checked here
  // because it goes straight onto the 2dsphere index: a malformed pair would fail the write
  // obscurely, and [0, 0] would quietly drop the restaurant off the map.
  if (updates.location !== undefined) {
    const coordinates = updates.location?.coordinates?.map(Number);
    if (!isUsableCoordinatePair(coordinates)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'location.coordinates must be [longitude, latitude]');
    }
    updates.location = { type: 'Point', coordinates };
  }

  // Address moved but no explicit point supplied — re-geocode the merged address so location
  // doesn't keep pointing at the old premises. Best-effort here (unlike creation): a geocoder
  // outage shouldn't block an owner from fixing a typo in the rest of their profile, and the
  // existing coordinates stay valid until the lookup succeeds.
  if (addressChanged && !updates.location) {
    const coords = await geocodeAddress(mergedAddress);
    if (coords) updates.location = { type: 'Point', coordinates: coords };
  }

  const updated = await Restaurant.findByIdAndUpdate(
    req.restaurant._id,
    { $set: { ...updates, ownerEditedAt: new Date() } },
    { new: true, runValidators: true }
  );
  // The storefront reads the restaurant through this cache, as the settings routes know.
  await cacheService.invalidate(`cache:restaurant:${req.restaurant._id}`);

  sendSuccess(res, 200, 'Restaurant updated', { restaurant: updated });
});
