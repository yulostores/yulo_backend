import Restaurant from '../../models/Restaurant.js';
import * as uploadService from '../../services/upload.service.js';
import * as cacheService from '../../services/cache.service.js';
import { geocodeAddress } from '../../services/geocode.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  buildStoreSettingsRequirements,
  validateRequiredStoreSettings,
} from '../../config/storeSettings.config.js';

const invalidateRestaurantCache = (restaurantId) =>
  cacheService.invalidate(`cache:restaurant:${restaurantId}`);

// The store-settings form always posts multipart/form-data so a logo or banner file can
// ride along, and multipart carries every field as a string — objects and arrays arrive
// JSON-encoded. They have to be decoded before use, and nothing downstream catches it if
// they aren't: mongoose casts a stringified `address` onto the nested path verbatim (no
// CastError — it is stored as a String and read back with every subfield undefined), and
// every `settings.*` read comes back undefined, so the compliance fields save as silent
// no-ops behind a 200. Mirrors parseArrayField in
// controllers/owner/menuItem.controller.js. JSON callers pass real objects through
// untouched.
//
// A malformed value has to fail loudly for the same reason — handing the raw string back
// to the caller feeds it straight into that cast.
const parseJsonField = (raw, field) => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be valid JSON`);
  }
};

// Restaurants saved before parseJsonField existed still hold `address` (and, in
// principle, `settings`) as the raw JSON *string* multipart delivered. Mongo refuses to
// write through one: a dot-notation $set answers "Cannot create field 'city' in element
// {address: ...}", so every save on such a restaurant failed until the value became an
// object again. scripts/fixStringifiedRestaurantFields.js
// repairs them in bulk; updateSettings below heals the one being edited so an owner is
// never blocked waiting for that script to be run.
const asObject = (value, fallbackKey) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — a bare street string. Keeping it beats discarding the only address
    // the owner ever typed.
  }
  return fallbackKey ? { [fallbackKey]: value } : {};
};

// Schema defaults only apply on insert, so the whole-object $set that repairs a
// stringified `settings` has to carry them itself or the restaurant would silently lose
// its GST and service-charge percentages.
const SETTINGS_DEFAULTS = Object.fromEntries(
  Object.entries(Restaurant.schema.paths)
    .filter(([path, type]) => path.startsWith('settings.') && type.options.default !== undefined)
    .map(([path, type]) => [path.slice('settings.'.length), type.options.default])
);

export const getSettings = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Restaurant settings', { restaurant: req.restaurant });
});

// GET /api/owner/settings-requirements — the field contract behind the store-settings
// screen: labels, which fields are mandatory, the pattern each value must match, the
// dropdown options, and the brand-image limits. Restaurant-agnostic on purpose, so the
// "Add Your Restaurant" step (which runs before any restaurant exists) is built from the
// same source as the settings form it turns into.
export const getSettingsRequirements = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, 'Store settings requirements', {
    requirements: buildStoreSettingsRequirements(),
  });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const { name, description, email, phone, website, establishedYear } = req.body;
  const cuisineTypes = parseJsonField(req.body.cuisineTypes, 'cuisineTypes');
  const address = parseJsonField(req.body.address, 'address');
  const settings = parseJsonField(req.body.settings, 'settings');

  // Decoding says nothing about shape — `address: "12 Main Road"` parses fine as a plain
  // string and would still be cast into the schema as one.
  if (cuisineTypes !== undefined && !Array.isArray(cuisineTypes)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'cuisineTypes must be an array');
  }
  for (const [field, value] of [['address', address], ['settings', settings]]) {
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be an object`);
    }
  }

  // Mandatory fields are checked against the restaurant as it *would* be after this patch,
  // not against the patch alone — otherwise clearing a required field by omitting it from
  // the request would sail straight through. Runs before the uploads below so a rejected
  // save never leaves a freshly-uploaded logo stranded in Cloudinary.
  const existing = req.restaurant.toObject();
  // Normalise first: spreading a stringified address gives character-indexed keys, which
  // would fail the required-field gate with an address the owner can plainly see on screen.
  const existingAddress = asObject(existing.address, 'street');
  const existingSettings = asObject(existing.settings);
  const addressIsStringified = typeof existing.address === 'string';
  const settingsIsStringified = typeof existing.settings === 'string';
  const fieldErrors = validateRequiredStoreSettings({
    ...existing,
    ...(name !== undefined && { name }),
    ...(email !== undefined && { email }),
    ...(phone !== undefined && { phone }),
    ...(website !== undefined && { website }),
    ...(description !== undefined && { description }),
    ...(establishedYear !== undefined && { establishedYear }),
    ...(cuisineTypes !== undefined && { cuisineTypes }),
    address: { ...existingAddress, ...address },
    settings: { ...existingSettings, ...settings },
  });
  if (Object.keys(fieldErrors).length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Some required details are missing or invalid',
      { fieldErrors }
    );
  }

  // Held so the superseded Cloudinary assets can be reaped after a successful write, and
  // so freshly-uploaded ones can be rolled back if the write fails. Without this, every
  // re-upload orphaned the previous logo/banner in Cloudinary forever.
  const previousLogo = req.restaurant.logo;
  const previousBanner = req.restaurant.bannerImage;
  const uploadedPublicIds = [];

  let logoUrl = previousLogo;
  let bannerUrl = previousBanner;

  if (req.files?.logo?.[0]) {
    try {
      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: req.files.logo[0].buffer,
        folder: `yulostores/brands/${req.restaurant._id}`,
        publicId: `logo_${Date.now()}`,
      });
      logoUrl = secureUrl;
      uploadedPublicIds.push(publicId);
    } catch {
      throw new ApiError(500, 'UPLOAD_FAILED', 'Logo upload failed');
    }
  }

  if (req.files?.banner?.[0]) {
    try {
      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: req.files.banner[0].buffer,
        folder: `yulostores/brands/${req.restaurant._id}`,
        publicId: `banner_${Date.now()}`,
      });
      bannerUrl = secureUrl;
      uploadedPublicIds.push(publicId);
    } catch {
      // A logo may already be up at this point — drop it rather than leave it stranded.
      await Promise.all(uploadedPublicIds.map((id) => uploadService.deleteImage(id).catch(() => {})));
      throw new ApiError(500, 'UPLOAD_FAILED', 'Banner upload failed');
    }
  }

  // Use dot-notation $set so existing settings fields (gstPercent, serviceChargePercent, etc.)
  // are preserved — replacing the whole settings object would wipe their defaults.
  const patch = {
    name, description, cuisineTypes, email, phone, website,
    logo: logoUrl,
    bannerImage: bannerUrl,
    ...(establishedYear !== undefined && { establishedYear: establishedYear || null }),
  };

  // Dot-notation for the same reason as `settings.*` below: the settings form edits only
  // `street`, and a whole-object $set would drop the city/state/pincode captured at
  // onboarding — taking the geocodable part of the address with them. The one exception
  // is a legacy stringified address, handled below.
  const mergedAddress = { ...existingAddress, ...address };
  if (address || addressIsStringified) {
    if (addressIsStringified) {
      // A stringified address is the one case where the whole object has to be written:
      // dot-notation cannot reach through a string, and the merge above already carries
      // the subfields this form doesn't edit. Repairs the document on the way past.
      patch.address = Object.fromEntries(
        ['street', 'city', 'state', 'pincode'].map((key) => [key, mergedAddress[key] ?? ''])
      );
    } else {
      for (const key of ['street', 'city', 'state', 'pincode']) {
        if (address[key] !== undefined) patch[`address.${key}`] = address[key];
      }
    }

    // Keep the map point in step with an edited address — same best-effort re-geocode as
    // PATCH /owner/:rId/restaurant (controllers/owner/restaurant.controller.js); a geocoder
    // miss leaves the existing coordinates alone rather than failing the whole save.
    // Geocode the merged address, not the patch: "12 Main Road" on its own rarely
    // resolves, "12 Main Road, Delhi, 110001" does.
    const coords = await geocodeAddress(mergedAddress);
    if (coords) patch.location = { type: 'Point', coordinates: coords };
  }
  const settingsPatch = {};
  for (const key of ['legalEntityType', 'ownerName', 'panNumber', 'gstNumber', 'healthPermitId', 'registrationNo']) {
    if (settings?.[key] !== undefined) settingsPatch[key] = settings[key];
  }
  // A cleared date arrives as '' — store null rather than letting the Date cast reject it.
  for (const key of ['licenseExpiry', 'tradeLicenseExpiry']) {
    if (settings?.[key] !== undefined) settingsPatch[key] = settings[key] || null;
  }
  if (settingsIsStringified) {
    patch.settings = { ...SETTINGS_DEFAULTS, ...existingSettings, ...settingsPatch };
  } else {
    for (const [key, value] of Object.entries(settingsPatch)) patch[`settings.${key}`] = value;
  }

  let updated;
  try {
    // runValidators so a bad value is a 400 from the schema rather than a silent write —
    // matches PATCH /owner/:rId/restaurant.
    updated = await Restaurant.findByIdAndUpdate(
      req.restaurant._id,
      { $set: patch },
      { new: true, runValidators: true }
    );
  } catch (err) {
    await Promise.all(uploadedPublicIds.map((id) => uploadService.deleteImage(id).catch(() => {})));
    throw err;
  }

  // Only after the write succeeds — a failed save must never cost the owner the brand
  // image they still have on screen. Same ordering as menu item images in
  // controllers/owner/menuItem.controller.js.
  const replaced = [
    logoUrl !== previousLogo ? previousLogo : null,
    bannerUrl !== previousBanner ? previousBanner : null,
  ].filter(Boolean);

  await Promise.all(
    replaced
      .map((url) => uploadService.extractPublicId(url))
      .filter(Boolean)
      .map((id) => uploadService.deleteImage(id).catch(() => {}))
  );

  await invalidateRestaurantCache(req.restaurant._id);
  sendSuccess(res, 200, 'Settings updated', { restaurant: updated });
});

export const getHours = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Operating hours', { operatingHours: req.restaurant.operatingHours });
});

// Replaces the whole week — the form always posts all seven days. Shape, the HHMM range
// and duplicate days are checked by the route's zod schema before this runs.
export const updateHours = asyncHandler(async (req, res) => {
  const { operatingHours } = req.body;
  const updated = await Restaurant.findByIdAndUpdate(
    req.restaurant._id,
    { $set: { operatingHours } },
    { new: true }
  );
  await invalidateRestaurantCache(req.restaurant._id);
  sendSuccess(res, 200, 'Operating hours updated', { operatingHours: updated.operatingHours });
});

export const getDelivery = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Delivery config', { delivery: req.restaurant.delivery });
});

// Replaces the whole `delivery` sub-object rather than merging, so omitting a key clears
// it — that is how the owner portal removes a free-delivery threshold. Ranges are checked
// by the route's zod schema.
export const updateDelivery = asyncHandler(async (req, res) => {
  const { radiusKm, baseCharge, freeThreshold, estimatedMinutes } = req.body;
  const updated = await Restaurant.findByIdAndUpdate(
    req.restaurant._id,
    { $set: { delivery: { radiusKm, baseCharge, freeThreshold, estimatedMinutes } } },
    { new: true }
  );
  await invalidateRestaurantCache(req.restaurant._id);
  sendSuccess(res, 200, 'Delivery config updated', { delivery: updated.delivery });
});
