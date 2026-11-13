import Seller from '../../models/Seller.js';
import SellerUser from '../../models/SellerUser.js';
import CouponCategory from '../../models/CouponCategory.js';
import * as authService from '../../services/auth.service.js';
import * as otpService from '../../services/otp.service.js';
import { SELLER_PERMISSIONS } from '../../config/coupon.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { setRefreshCookie, clearRefreshCookie, readRefreshToken } from '../../utils/refreshCookie.js';

// Seller (coupon partner) portal sign-in: phone + OTP for everyone, and an optional password for
// owners. One person may hold logins at several sellers (models/SellerUser.js), so a verified
// number can lead to zero, one or many logins:
//
//   none  → { needsSignup, signupToken }       the portal offers business signup (CB3), which
//                                                accepts the token as proof of the number
//   one   → a session                          { accessToken, user, seller, permissions }
//   many  → { needsAccountChoice, selectToken, accounts }
//                                                POST /select-account with one of them
//
// Sessions are access + refresh (services/auth.service.js); the refresh token lives in the
// seller portal's own httpOnly cookie (utils/refreshCookie.js, 'seller').

const SELLER_PORTAL = 'seller';

// Its own OTP namespace (services/otp.service.js), so a code requested for a customer, partner
// or staff login on the same number can never finish a seller sign-in.
const SELLER_OTP_SCOPE = 'seller';

const activeLoginsFor = (phone) =>
  SellerUser.find({ phone, isActive: true }).sort({ createdAt: 1 }).lean();

const sellersById = async (users) => {
  const sellers = await Seller.find({ _id: { $in: users.map((u) => u.sellerId) } })
    .select('businessName status rejectionReason')
    .lean();
  return new Map(sellers.map((s) => [String(s._id), s]));
};

const toUserView = (user) => ({
  _id: user._id,
  name: user.name,
  phone: user.phone,
  role: user.role,
  sellerId: user.sellerId,
});

const toSellerView = (seller) => ({
  _id: seller._id,
  businessName: seller.businessName,
  status: seller.status,
  rejectionReason: seller.status === 'rejected' ? seller.rejectionReason ?? null : null,
});

const toAccountChoice = (user, seller) => ({
  sellerUserId: user._id,
  sellerId: user.sellerId,
  businessName: seller?.businessName ?? null,
  sellerStatus: seller?.status ?? null,
  role: user.role,
});

// Signs `user` in: a fresh token pair, the refresh token in the portal's cookie, and the profile
// the portal boots from.
const startSession = async (res, user, seller, message = 'Login successful') => {
  const { accessToken, refreshToken } = authService.generateSellerTokens(user);
  await SellerUser.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  setRefreshCookie(res, SELLER_PORTAL, refreshToken);
  sendSuccess(res, 200, message, {
    accessToken,
    user: toUserView(user),
    seller: toSellerView(seller),
    permissions: SELLER_PERMISSIONS[user.role] ?? [],
  });
};

// What a number that has passed OTP (or a password) gets: see the header comment.
const respondForVerifiedPhone = async (res, phone, users) => {
  if (users.length === 0) {
    return sendSuccess(res, 200, 'No seller account uses this number yet', {
      needsSignup: true,
      phone,
      signupToken: authService.generateSellerProofToken(authService.SELLER_TOKEN_TYPES.signup, phone),
    });
  }
  const sellers = await sellersById(users);
  if (users.length === 1) return startSession(res, users[0], sellers.get(String(users[0].sellerId)));

  return sendSuccess(res, 200, 'Choose which business to sign in to', {
    needsAccountChoice: true,
    selectToken: authService.generateSellerProofToken(authService.SELLER_TOKEN_TYPES.select, phone, {
      sellerUserIds: users.map((u) => String(u._id)),
    }),
    accounts: users.map((u) => toAccountChoice(u, sellers.get(String(u.sellerId)))),
  });
};

/**
 * POST /api/seller/auth/otp/send  { phone }
 *
 * Always sends: a brand-new seller signs up with this same code, so a number with no login is
 * not a reason to refuse. Per-number send limits apply (services/otp.service.js).
 */
export const sendSellerOtp = asyncHandler(async (req, res) => {
  const result = await otpService.requestOtp(req.body.phone, { scope: SELLER_OTP_SCOPE });
  sendSuccess(res, 200, 'A code has been sent', {
    phone: result.phone,
    ...(result.otpBypass ? { otpBypass: true } : {}),
    // Dev only (SMS_PROVIDER=mock outside production) — see otp.service.js.
    ...(result.devOtp ? { devOtp: result.devOtp } : {}),
  });
});

/** POST /api/seller/auth/otp/verify  { phone, code } */
export const verifySellerOtp = asyncHandler(async (req, res) => {
  const { phone, code } = req.body;
  // Throws OTP_EXPIRED / INVALID_OTP / OTP_LOCKED.
  await otpService.verifyOtp(phone, code, { scope: SELLER_OTP_SCOPE });
  await respondForVerifiedPhone(res, phone, await activeLoginsFor(phone));
});

/** POST /api/seller/auth/select-account  { selectToken, sellerUserId } */
export const selectSellerAccount = asyncHandler(async (req, res) => {
  const { selectToken, sellerUserId } = req.body;
  const proof = await authService.verifySellerToken(selectToken, authService.SELLER_TOKEN_TYPES.select);
  if (!proof.sellerUserIds?.includes(sellerUserId)) {
    throw new ApiError(403, 'FORBIDDEN', 'That account was not offered for this sign-in');
  }
  // Re-read: the login may have been deactivated, or its number changed, since the OTP.
  const user = await SellerUser.findOne({ _id: sellerUserId, phone: proof.phone, isActive: true }).lean();
  if (!user) throw new ApiError(401, 'INVALID_CREDENTIALS', 'This account is no longer available');
  // One use: the proof is spent, so it can't sign in to the other accounts later.
  await authService.blacklistToken(selectToken);
  const seller = await Seller.findById(user.sellerId).select('businessName status rejectionReason').lean();
  await startSession(res, user, seller);
});

// Verified against when no owner with a password matches the number, so a wrong number and a
// wrong password take the same time to refuse.
let dummyHash = null;
const getDummyHash = async () => {
  dummyHash ??= await authService.hashPassword('not-a-real-password-placeholder');
  return dummyHash;
};

/**
 * POST /api/seller/auth/login  { phone, password }
 *
 * Owners only, and only once they have set a password (POST /password). Everyone else signs in
 * with an OTP. One generic answer for every failure, so it can't be used to learn which numbers
 * are owners.
 */
export const sellerPasswordLogin = asyncHandler(async (req, res) => {
  const { phone, password } = req.body;
  const candidates = await SellerUser.find({
    phone,
    role: 'owner',
    isActive: true,
    passwordHash: { $type: 'string' },
  })
    .select('+passwordHash')
    .sort({ createdAt: 1 })
    .lean();

  const matched = [];
  for (const user of candidates) {
    if (await authService.verifyPassword(user.passwordHash, password)) matched.push(user);
  }
  if (candidates.length === 0) await authService.verifyPassword(await getDummyHash(), password);
  if (matched.length === 0) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect phone number or password');
  }
  await respondForVerifiedPhone(
    res,
    phone,
    matched.map(({ passwordHash, ...user }) => user)
  );
});

/**
 * POST /api/seller/auth/refresh
 *
 * A new access token from the refresh cookie. The refresh token carries the session version
 * too, so a deactivated or bumped user can't quietly refresh their way past it.
 */
export const refreshSellerSession = asyncHandler(async (req, res) => {
  const token = readRefreshToken(req, SELLER_PORTAL);
  if (!token) throw new ApiError(401, 'INVALID_TOKEN', 'No refresh token');
  const decoded = await authService.verifySellerToken(token, authService.SELLER_TOKEN_TYPES.refresh);

  const user = await SellerUser.findById(decoded.sellerUserId).lean();
  if (!user || !user.isActive) throw new ApiError(401, 'INVALID_TOKEN', 'Seller user not found');
  if (decoded.sv !== (user.sessionVersion ?? 0)) {
    throw new ApiError(401, 'INVALID_TOKEN', 'Your session has ended. Please sign in again.');
  }
  const { accessToken } = authService.generateSellerTokens(user);
  sendSuccess(res, 200, 'Token refreshed', { accessToken });
});

/**
 * GET /api/seller/auth/me
 *
 * The portal boots from this rather than a cached profile: the role, the seller's status and the
 * permissions may all have changed since the last visit.
 */
export const sellerSession = asyncHandler(async (req, res) => {
  const [user, seller] = await Promise.all([
    SellerUser.findById(req.seller.userId).lean(),
    Seller.findById(req.seller.sellerId).select('businessName status rejectionReason').lean(),
  ]);
  if (!user || !seller) throw new ApiError(401, 'INVALID_TOKEN', 'Seller user not found');

  sendSuccess(res, 200, 'Seller session', {
    user: toUserView(user),
    seller: toSellerView(seller),
    permissions: SELLER_PERMISSIONS[user.role] ?? [],
    hasPassword: Boolean(await SellerUser.exists({ _id: user._id, passwordHash: { $type: 'string' } })),
    expiresAt: req.seller.tokenExpiresAt ?? null,
  });
});

/**
 * POST /api/seller/auth/password  { currentPassword?, newPassword }   owner only
 *
 * Sets or changes the owner's optional password. Changing an existing one needs the current
 * one; setting the first one needs only the signed-in session.
 */
export const setSellerPassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await SellerUser.findById(req.seller.userId).select('+passwordHash');
  if (!user) throw new ApiError(401, 'INVALID_TOKEN', 'Seller user not found');

  if (user.passwordHash) {
    const ok = currentPassword ? await authService.verifyPassword(user.passwordHash, currentPassword) : false;
    if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect');
  }
  user.passwordHash = await authService.hashPassword(newPassword);
  await user.save();
  sendSuccess(res, 200, 'Password saved', null);
});

/**
 * POST /api/seller/auth/logout
 *
 * Revokes this access token and the refresh token in the cookie, and clears the cookie. Other
 * devices stay signed in.
 */
export const sellerLogout = asyncHandler(async (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) await authService.blacklistToken(header.slice(7));
  const refreshToken = readRefreshToken(req, SELLER_PORTAL);
  if (refreshToken) await authService.blacklistToken(refreshToken);
  clearRefreshCookie(res, SELLER_PORTAL);
  sendSuccess(res, 200, 'Logged out', null);
});

// ── Signup ────────────────────────────────────────────────────────────────────

/**
 * GET /api/seller/auth/categories
 *
 * The business categories a new seller picks from at signup. Public — signup happens before
 * any session exists — and thin: the key and name are all the form needs. Every category is
 * offered, enabled or not: `enabled` decides which categories customers receive coupons from,
 * not which businesses may join.
 */
export const listSignupCategories = asyncHandler(async (req, res) => {
  const categories = await CouponCategory.find().sort({ sortOrder: 1, name: 1 }).select('key name icon').lean();
  sendSuccess(res, 200, 'Categories', { categories });
});

/**
 * POST /api/seller/auth/signup  { signupToken, businessName, categoryId, ownerName }
 *
 * Creates the business (pending review) and its owner login, and signs the owner in. The phone
 * is the one proven by OTP: `signupToken` comes from POST /otp/verify on a number with no
 * login, and is spent here so it can't create a second business.
 *
 * No transaction (this codebase runs on a standalone MongoDB): the seller is written first and
 * removed again if the owner login can't be.
 */
export const sellerSignup = asyncHandler(async (req, res) => {
  const { signupToken, businessName, categoryId, ownerName } = req.body;
  const proof = await authService.verifySellerToken(signupToken, authService.SELLER_TOKEN_TYPES.signup);
  const { phone } = proof;

  if (!(await CouponCategory.exists({ _id: categoryId }))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a business category from the list', {
      fieldErrors: { categoryId: ['Unknown category'] },
    });
  }
  // One business per owner number. The same person may still be a manager or employee
  // elsewhere — those logins are created by other owners, not here.
  if (await SellerUser.exists({ phone, role: 'owner', isActive: true })) {
    throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', 'This number already owns a business on Yulo. Sign in instead.');
  }

  const seller = await Seller.create({ businessName, categoryId, owner: { name: ownerName, phone } });
  let owner;
  try {
    owner = await SellerUser.create({ sellerId: seller._id, name: ownerName, phone, role: 'owner' });
  } catch (err) {
    await Seller.deleteOne({ _id: seller._id }).catch(() => {});
    throw err;
  }
  await authService.blacklistToken(signupToken);

  const { accessToken, refreshToken } = authService.generateSellerTokens(owner);
  setRefreshCookie(res, SELLER_PORTAL, refreshToken);
  sendSuccess(res, 201, 'Business created — complete your details to send it for review', {
    accessToken,
    user: toUserView(owner),
    seller: toSellerView(seller),
    permissions: SELLER_PERMISSIONS.owner,
  });
});
