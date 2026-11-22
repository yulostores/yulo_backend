import User from '../../models/User.js';
import * as authService from '../../services/auth.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { setRefreshCookie, clearRefreshCookie } from '../../utils/refreshCookie.js';

export const ownerSignup = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw new ApiError(409, 'DUPLICATE_KEY', 'email already exists');
  // The mobile number is the owner's login, and it is unique across every account (a customer
  // signs in to the app with the same field), so a number already in use can't be reused here.
  if (await User.exists({ phone })) {
    throw new ApiError(409, 'DUPLICATE_KEY', 'This mobile number is already registered');
  }

  const passwordHash = await authService.hashPassword(password);
  const user = await User.create({
    name,
    email,
    phone,
    passwordHash,
    role: 'restaurant_owner',
  });

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, 201, 'Account created — add a restaurant to begin admin review', {
    user,
    accessToken,
  });
});

// Mobile number + password. `phone` arrives normalised to 10 digits (routes/owner/auth.routes.js).
export const ownerLogin = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;

  const user = await User.findOne({ phone, role: 'restaurant_owner' });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid mobile number or password');
  }

  const valid = await authService.verifyPassword(user.passwordHash, password);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid mobile number or password');

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, 200, 'Login successful', { user, accessToken });
});

export const ownerLogout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    await authService.blacklistToken(header.slice(7));
  }
  clearRefreshCookie(res, 'owner');
  sendSuccess(res, 200, 'Logged out', null);
});
