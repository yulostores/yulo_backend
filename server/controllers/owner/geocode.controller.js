import { z } from 'zod';
import { geocodeAddress } from '../../services/geocode.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// GET /api/owner/geocode?street&city&state&pincode — where an address sits on the map, so the
// registration map can jump to it before the owner fine-tunes the pin by hand. Same geocoder
// (and provider order) the server uses when a restaurant is created without a pin.
const querySchema = z.object({
  street: z.string().trim().max(300).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  pincode: z.string().trim().max(10).optional(),
});

export const geocode = asyncHandler(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid address');
  const address = parsed.data;
  if (!address.city && !address.pincode) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Enter at least the city or PIN code');
  }
  const coordinates = await geocodeAddress(address);
  if (!coordinates) {
    throw new ApiError(404, 'ADDRESS_NOT_FOUND', "We couldn't find that address on the map — place the pin by hand");
  }
  sendSuccess(res, 200, 'Address located', { lng: coordinates[0], lat: coordinates[1] });
});
