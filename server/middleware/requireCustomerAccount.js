import { ApiError } from '../utils/ApiError.js';

// A guest session (POST /api/auth/customer/guest) authenticates fine and can browse,
// use the cart, favorite things and set preferences/addresses — but it never counts as
// a real customer for checkout, past orders, reviews or support. 401, not 403: from the
// app's point of view this is exactly the "please sign in" case every screen already
// renders (src/hooks/*.ts's `notSignedIn`), not a permissions error to explain away.
export const requireCustomerAccount = (req, res, next) => {
  if (req.user?.role === 'guest') {
    throw new ApiError(401, 'GUEST_ACCOUNT_REQUIRED', 'Sign in to continue');
  }
  next();
};
