import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';
import * as authService from '../services/auth.service.js';
import * as otpService from '../services/otp.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshToken,
  portalForRole,
  isPortal,
} from '../utils/refreshCookie.js';

export const signup = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw new ApiError(409, 'DUPLICATE_KEY', 'email already exists');

  const passwordHash = await authService.hashPassword(password);
  // This endpoint only ever creates customers — restaurant owners sign up at
  // /api/owner/auth/signup, admins are provisioned separately (see seedSuperAdmin.js).
  const user = await User.create({ name, email, passwordHash, role: 'customer' });

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, 201, 'Account created', { user, accessToken });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // This endpoint is customer-only — owners log in at /api/owner/auth/login and admins
  // at /api/admin/auth/login, so a non-customer account never mints a token here.
  const user = await User.findOne({ email, role: 'customer' });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const valid = await authService.verifyPassword(user.passwordHash, password);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, 200, 'Login successful', { user, accessToken });
});

export const sendCustomerOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  const result = await otpService.requestOtp(phone);
  sendSuccess(res, 200, 'OTP sent', result);
});

export const verifyCustomerOtp = asyncHandler(async (req, res) => {
  const { phone, code, tosAccepted } = req.body;
  await otpService.verifyOtp(phone, code);

  let user = await User.findOne({ phone });
  let isNewUser = false;

  if (!user) {
    // First touchpoint for a brand-new customer — just phone + verification state, same
    // as controllers/partner/auth.controller.js's verifyOtpHandler. Name/email/profile are
    // completed later via PATCH /api/users/me.
    user = await User.create({
      phone,
      role: 'customer',
      phoneVerifiedAt: new Date(),
      tosAcceptedAt: tosAccepted ? new Date() : null,
    });
    isNewUser = true;
  } else {
    // A phone number is only ever meant to identify a customer account here — if this
    // number is already attached to a restaurant_owner/admin record (both of which log
    // in with email+password only), refuse rather than silently minting a token for a
    // higher-privileged role off of phone possession alone.
    if (user.role !== 'customer') {
      throw new ApiError(403, 'FORBIDDEN', 'This phone number is linked to a different account type');
    }
    if (!user.isActive) {
      throw new ApiError(401, 'ACCOUNT_SUSPENDED', 'This account has been deactivated');
    }
    user.phoneVerifiedAt = new Date();
    if (tosAccepted && !user.tosAcceptedAt) user.tosAcceptedAt = new Date();
    await user.save();
  }

  const { accessToken, refreshToken } = authService.generateTokens(user._id, user.role);
  setRefreshCookie(res, user.role, refreshToken);

  sendSuccess(res, isNewUser ? 201 : 200, isNewUser ? 'Account created' : 'Login successful', {
    user,
    accessToken,
    isNewUser,
  });
});

// Shared by the customer, owner and admin portals — they differ only in which
// refresh cookie is read, which the caller names with ?portal=. Requests without
// one fall back to the old shared cookie so clients that predate portal-scoped
// cookies keep working (utils/refreshCookie.js).
export const refresh = asyncHandler(async (req, res) => {
  const { portal } = req.query;
  if (portal !== undefined && !isPortal(portal)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown portal');
  }

  const token = readRefreshToken(req, portal);
  if (!token) throw new ApiError(401, 'INVALID_TOKEN', 'No refresh token');

  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);

  const user = await User.findById(decoded.userId).lean();
  if (!user || !user.isActive) throw new ApiError(401, 'INVALID_TOKEN', 'User not found');

  // Never hand a portal an access token for a different role — a stale legacy
  // cookie from another portal would otherwise silently take over this session.
  if (portal && portalForRole(user.role) !== portal) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Session belongs to another portal');
  }

  const accessToken = jwt.sign(
    { userId: user._id, role: user.role },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES }
  );

  sendSuccess(res, 200, 'Token refreshed', { accessToken });
});

export const logout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    await authService.blacklistToken(header.slice(7));
  }
  // Only this portal's cookie — signing out of the QR app must not sign the
  // owner out of the portal running on the same host.
  clearRefreshCookie(res, portalForRole(req.user?.role) ?? 'customer');
  sendSuccess(res, 200, 'Logged out', null);
});
