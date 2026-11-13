import * as account from '../../services/sellerAccount.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — partner agreement and business profile (services/sellerAccount.service.js).

/** GET /api/seller/agreement — owner and manager. */
export const getAgreement = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Agreement', { agreement: await account.getAgreement(req.seller.sellerId) });
});

/** POST /api/seller/agreement/accept { version } — owner. */
export const acceptAgreement = asyncHandler(async (req, res) => {
  const agreement = await account.acceptAgreement(req.seller.sellerId, req.seller.userId, req.body, { ip: req.ip ?? null });
  sendSuccess(res, 200, 'Agreement accepted', { agreement });
});

/** GET /api/seller/profile — owner and manager. */
export const getProfile = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Profile', { profile: await account.getProfile(req.seller.sellerId) });
});

/** PATCH /api/seller/profile — owner; contact fields only. */
export const updateProfile = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Profile updated', { profile: await account.updateProfile(req.seller.sellerId, req.body) });
});
