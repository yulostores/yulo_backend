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

export const ownerLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email, role: 'restaurant_owner' });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const valid = await authService.verifyPassword(user.passwordHash, password);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

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
