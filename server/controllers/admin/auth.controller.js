import User from '../../models/User.js';
import * as authService from '../../services/auth.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { setRefreshCookie, clearRefreshCookie } from '../../utils/refreshCookie.js';

export const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email, role: 'admin' });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const valid = await authService.verifyPassword(user.passwordHash, password);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, 200, 'Login successful', { user, accessToken });
});

export const adminLogout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    await authService.blacklistToken(header.slice(7));
  }
  clearRefreshCookie(res, 'admin');
  sendSuccess(res, 200, 'Logged out', null);
});
