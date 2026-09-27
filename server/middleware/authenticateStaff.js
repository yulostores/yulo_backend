import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import Restaurant from '../models/Restaurant.js';
import StaffMember from '../models/StaffMember.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTokenRevoked } from '../services/auth.service.js';

export const authenticateStaff = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');
  }
  const token = header.slice(7);

  // Verify before consulting the denylist: revocation is keyed on the token's `jti`
  // (services/auth.service.js), which only means anything once the signature has been
  // checked — and a forged token never needs a Redis round-trip to be rejected.
  const decoded = jwt.verify(token, env.JWT_STAFF_SECRET);

  if (await isTokenRevoked(decoded, token)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Token has been revoked');
  }

  const staff = await StaffMember.findById(decoded.staffId).lean();
  if (!staff || !staff.isActive) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Staff member not found');
  }
  // Issued before the member's phone changed (or before a PIN-era token was retired): those
  // sessions are over. Old PIN tokens carry no `sv` at all, so they end here too.
  if (decoded.sv !== (staff.sessionVersion ?? 0)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Your session has ended. Please sign in again.');
  }

  // A restaurant suspended (or otherwise taken off the platform) mid-session: its staff must
  // stop working it now, not whenever their 24h token happens to run out.
  const restaurant = await Restaurant.findById(staff.restaurantId).select('isActive approvalStatus').lean();
  if (!restaurant?.isActive || restaurant.approvalStatus !== 'active') {
    throw new ApiError(
      403,
      'RESTAURANT_UNAVAILABLE',
      'This restaurant is not currently active. Please contact your manager.'
    );
  }

  req.staff = {
    _id: staff._id,
    role: staff.role,
    restaurantId: staff.restaurantId,
    name: staff.name,
    tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
  };
  next();
});
