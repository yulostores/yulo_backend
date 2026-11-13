import { ApiError } from '../utils/ApiError.js';

// After authenticateSeller: which seller roles (owner / manager / employee) may use a route.
// Mirrors authorizeRole for User roles.
export const authorizeSellerRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.seller?.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Your role cannot do this');
  }
  next();
};
