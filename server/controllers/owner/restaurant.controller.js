import Restaurant from '../../models/Restaurant.js';
import { geocodeAddress } from '../../services/geocode.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateCreateRestaurant } from '../../config/storeSettings.config.js';

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
  // otherwise the address is geocoded here. A failed lookup rejects the request instead of
  // falling back to [0, 0]: that fallback silently dropped every such restaurant into the
  // Gulf of Guinea, where the 2dsphere $near queries that power "nearby restaurants" would
  // never surface it for its actual city.
  let coords = location?.coordinates?.length === 2 ? location.coordinates : null;
  if (!coords) {
    coords = await geocodeAddress(address);
    if (!coords) {
      throw new ApiError(
        400,
        'ADDRESS_NOT_FOUND',
        "We couldn't locate that address on the map. Please check the street, city and pincode."
      );
    }
  }

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

export const updateRestaurant = asyncHandler(async (req, res) => {
  const allowed = [
    'name',
    'description',
    'cuisineTypes',
    'address',
    'location',
    'isActive',
    'isPureVeg',
    'vegFleetAvailable',
    'badges',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // Address moved but no explicit point supplied — re-geocode so location doesn't keep
  // pointing at the old premises. Best-effort here (unlike creation): a geocoder outage
  // shouldn't block an owner from fixing a typo in the rest of their profile, and the
  // existing coordinates stay valid until the lookup succeeds.
  if (updates.address && !updates.location) {
    const coords = await geocodeAddress(updates.address);
    if (coords) updates.location = { type: 'Point', coordinates: coords };
  }

  const updated = await Restaurant.findByIdAndUpdate(
    req.restaurant._id,
    { $set: updates },
    { new: true, runValidators: true }
  );

  sendSuccess(res, 200, 'Restaurant updated', { restaurant: updated });
});
