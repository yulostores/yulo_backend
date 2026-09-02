import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTokenRevoked } from '../services/auth.service.js';

export const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');
  }
  const token = header.slice(7);

  // Verify before consulting the denylist: revocation is keyed on the token's `jti`
  // (services/auth.service.js), which only means anything once the signature has been
  // checked — and a forged token never needs a Redis round-trip to be rejected.
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);

  if (await isTokenRevoked(decoded, token)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Token has been revoked');
  }

  const user = await User.findById(decoded.userId).lean();
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_TOKEN', 'User not found');
  }

  req.user = { _id: user._id, role: user.role, name: user.name, email: user.email };
  next();
});
