import { Router } from 'express';
import { z } from 'zod';
import {
  signup,
  login,
  refresh,
  logout,
  sendCustomerOtp,
  verifyCustomerOtp,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const customerOtpSendSchema = z.object({
  phone: z.string().regex(/^\d{10}$/, 'Enter a valid 10-digit phone number'),
});

const customerOtpVerifySchema = z.object({
  phone: z.string().regex(/^\d{10}$/, 'Enter a valid 10-digit phone number'),
  code: z.string().length(6, 'Enter the 6-digit code'),
  tosAccepted: z
    .boolean()
    .refine((v) => v === true, 'You must accept the Terms & Privacy Policy'),
});

router.post('/signup', authLimiter, validate(signupSchema), signup);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/customer/otp/send', authLimiter, validate(customerOtpSendSchema), sendCustomerOtp);
router.post(
  '/customer/otp/verify',
  authLimiter,
  validate(customerOtpVerifySchema),
  verifyCustomerOtp
);
router.post('/refresh', refresh);
router.post('/logout', authenticate, logout);

export default router;
