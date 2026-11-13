import { ApiError } from '../utils/ApiError.js';

// After authenticateSeller: lets a request through only for a seller a super admin has approved
// and not suspended. Pending and rejected sellers can still sign in — to finish onboarding or
// fix what was rejected — but nothing that issues, redeems or reports coupons.
export const requireSellerActive = (req, res, next) => {
  const status = req.seller?.sellerStatus;
  if (status !== 'active') {
    throw new ApiError(
      403,
      'SELLER_NOT_ACTIVE',
      status === 'suspended'
        ? 'This business account is suspended. Please contact Yulo.'
        : 'This business account is not approved yet.',
      { sellerStatus: status ?? null }
    );
  }
  next();
};
