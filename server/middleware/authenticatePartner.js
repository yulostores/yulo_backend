import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTokenRevoked } from '../services/auth.service.js';

export const authenticatePartner = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');
  }
  const token = header.slice(7);

  // Verify before consulting the denylist: revocation is keyed on the token's `jti`
  // (services/auth.service.js), which only means anything once the signature has been
  // checked — and a forged token never needs a Redis round-trip to be rejected.
  const decoded = jwt.verify(token, env.JWT_PARTNER_SECRET);

  if (await isTokenRevoked(decoded, token)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Token has been revoked');
  }

  const partner = await DeliveryPartner.findById(decoded.partnerId).lean();
  if (!partner) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Delivery partner not found');
  }
  // DeliveryPartner has no isActive flag (unlike StaffMember) — 'suspended' is its equivalent
  // deactivated state, so block it here the same way authenticateStaff blocks !isActive.
  if (partner.status === 'suspended') {
    throw new ApiError(401, 'INVALID_TOKEN', 'Delivery partner account is suspended');
  }

  req.partner = {
    _id: partner._id,
    phone: partner.phone,
    fullName: partner.fullName,
    verificationStatus: partner.verificationStatus,
    fleetType: partner.fleetType,
    status: partner.status,
    currentLocation: partner.currentLocation,
    currentLocationUpdatedAt: partner.currentLocationUpdatedAt,
  };
  next();
});
