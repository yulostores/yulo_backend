import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifySellerToken, SELLER_TOKEN_TYPES } from '../services/auth.service.js';

// Seller (coupon partner) portal authentication — the twin of authenticateStaff. A seller access
// token (services/auth.service.js#generateSellerTokens) is accepted only while:
//   * it verifies with JWT_SELLER_SECRET and is an ACCESS token (not refresh/signup/select),
//   * it hasn't been revoked by logout,
//   * its SellerUser still exists, is active, and its sessionVersion matches the token's.
//
// The seller's own status is NOT checked here: a pending or rejected seller's owner must still
// reach onboarding and the status screen. Business routes add middleware/requireSellerActive.js.
//
// The token's role and seller are never trusted on their own — both are re-read from the
// SellerUser row, so a role change takes effect at once even before the session is bumped.
export const authenticateSeller = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'No token provided');
  }
  const token = header.slice(7);
  const decoded = await verifySellerToken(token, SELLER_TOKEN_TYPES.access);

  const user = await SellerUser.findById(decoded.sellerUserId).lean();
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Seller user not found');
  }
  if (decoded.sv !== (user.sessionVersion ?? 0)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Your session has ended. Please sign in again.');
  }

  const seller = await Seller.findById(user.sellerId).select('businessName status').lean();
  if (!seller) throw new ApiError(401, 'INVALID_TOKEN', 'Seller not found');

  req.seller = {
    userId: user._id,
    sellerId: user.sellerId,
    role: user.role,
    name: user.name,
    sellerStatus: seller.status,
    businessName: seller.businessName,
    tokenExpiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
  };
  next();
});
