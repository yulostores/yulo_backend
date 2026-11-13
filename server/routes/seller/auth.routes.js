import { Router } from 'express';
import { z } from 'zod';
import {
  sendSellerOtp,
  verifySellerOtp,
  selectSellerAccount,
  sellerPasswordLogin,
  refreshSellerSession,
  sellerSession,
  setSellerPassword,
  sellerLogout,
  sellerSignup,
  listSignupCategories,
} from '../../controllers/seller/auth.controller.js';
import { authenticateSeller } from '../../middleware/authenticateSeller.js';
import { authorizeSellerRole } from '../../middleware/authorizeSellerRole.js';
import { sellerAuthLimiter, refreshLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';
import { normalizeIndianPhone } from '../../utils/phone.js';

const router = Router();

// "+91 98765 43210", "09876543210" or "9876543210" → the bare 10 digits SellerUser stores.
const phoneField = z.preprocess(
  (v) => normalizeIndianPhone(v) ?? v,
  z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

const sendOtpSchema = z.object({ phone: phoneField }).strict();
const verifyOtpSchema = z
  .object({ phone: phoneField, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') })
  .strict();
const selectSchema = z.object({ selectToken: z.string().min(1).max(2000), sellerUserId: objectId }).strict();
const loginSchema = z.object({ phone: phoneField, password: z.string().min(1).max(200) }).strict();
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: z.string().min(8, 'Use at least 8 characters').max(200),
  })
  .strict();

const signupSchema = z
  .object({
    signupToken: z.string().min(1).max(2000),
    businessName: z.string().trim().min(2, 'Enter the business name').max(120),
    categoryId: objectId,
    ownerName: z.string().trim().min(2, 'Enter your name').max(100),
  })
  .strict();

router.get('/categories', listSignupCategories);
router.post('/signup', sellerAuthLimiter, validate(signupSchema), sellerSignup);
router.post('/otp/send', sellerAuthLimiter, validate(sendOtpSchema), sendSellerOtp);
router.post('/otp/verify', sellerAuthLimiter, validate(verifyOtpSchema), verifySellerOtp);
router.post('/select-account', sellerAuthLimiter, validate(selectSchema), selectSellerAccount);
router.post('/login', sellerAuthLimiter, validate(loginSchema), sellerPasswordLogin);
router.post('/refresh', refreshLimiter, refreshSellerSession);
router.get('/me', authenticateSeller, sellerSession);
router.post('/password', authenticateSeller, authorizeSellerRole('owner'), validate(passwordSchema), setSellerPassword);
router.post('/logout', authenticateSeller, sellerLogout);

export default router;
