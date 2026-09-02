import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isTokenRevoked } from '../services/auth.service.js';

// Like authenticate.js, but never rejects the request. Public browse endpoints (restaurant
// list/detail/menu) need to know WHO is asking — to thread `isFavorited` into the response —
// without requiring a token just to view them. Any failure (no header, invalid/expired
// token, blacklisted, user not found/inactive) just leaves req.user unset, identical to a
// genuinely anonymous request — it never surfaces as an error on these routes.
export const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (await isTokenRevoked(decoded, token)) return next();

    const user = await User.findById(decoded.userId).lean();
    if (user && user.isActive) {
      req.user = { _id: user._id, role: user.role, name: user.name, email: user.email };
    }
  } catch {
    // Invalid/expired token on a public endpoint — fall through as anonymous.
  }
  next();
});
