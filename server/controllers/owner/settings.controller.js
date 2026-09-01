import Restaurant from '../../models/Restaurant.js';
import * as uploadService from '../../services/upload.service.js';
import * as cacheService from '../../services/cache.service.js';
import { geocodeAddress } from '../../services/geocode.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

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

export const getSettings = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Restaurant settings', { restaurant: req.restaurant });
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
  // onboarding — taking the geocodable part of the address with them.
  if (address) {
    for (const key of ['street', 'city', 'state', 'pincode']) {
      if (address[key] !== undefined) patch[`address.${key}`] = address[key];
    }

    // Keep the map point in step with an edited address — same best-effort re-geocode as
    // PATCH /owner/:rId/restaurant (controllers/owner/restaurant.controller.js); a geocoder
    // miss leaves the existing coordinates alone rather than failing the whole save.
    // Geocode the merged address, not the patch: "12 Main Road" on its own rarely
    // resolves, "12 Main Road, Delhi, 110001" does.
    const coords = await geocodeAddress({ ...req.restaurant.toObject().address, ...address });
    if (coords) patch.location = { type: 'Point', coordinates: coords };
  }
  if (settings?.legalEntityType    !== undefined) patch['settings.legalEntityType']    = settings.legalEntityType;
  if (settings?.ownerName          !== undefined) patch['settings.ownerName']          = settings.ownerName;
  if (settings?.panNumber          !== undefined) patch['settings.panNumber']          = settings.panNumber;
  if (settings?.gstNumber          !== undefined) patch['settings.gstNumber']          = settings.gstNumber;
  if (settings?.healthPermitId     !== undefined) patch['settings.healthPermitId']     = settings.healthPermitId;
  if (settings?.licenseExpiry      !== undefined) patch['settings.licenseExpiry']      = settings.licenseExpiry || null;
  if (settings?.registrationNo     !== undefined) patch['settings.registrationNo']     = settings.registrationNo;
  if (settings?.tradeLicenseExpiry !== undefined) patch['settings.tradeLicenseExpiry'] = settings.tradeLicenseExpiry || null;

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
