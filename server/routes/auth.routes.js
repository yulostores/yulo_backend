import { Router } from 'express';
import { z } from 'zod';
import {
  signup,
  login,
  refresh,
  logout,
  guestLogin,
  sendCustomerOtp,
  verifyCustomerOtp,
} from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authLimiter, guestLoginLimiter, refreshLimiter } from '../middleware/rateLimiter.js';
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
  // Present when a guest session (see /customer/guest below) is completing a real
  // sign-in, so its cart/favorites/addresses can be carried over — see
  // verifyCustomerOtp / services/guestAccount.service.js. Invalid/expired is fine,
  // it's just ignored there. Capped well above any real JWT's size purely so a
  // malformed/oversized value 400s here instead of reaching jwt.verify.
  guestToken: z.string().max(2000).optional(),
});

router.post('/signup', authLimiter, validate(signupSchema), signup);
router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/customer/guest', guestLoginLimiter, guestLogin);
router.post('/customer/otp/send', authLimiter, validate(customerOtpSendSchema), sendCustomerOtp);
router.post(
  '/customer/otp/verify',
  authLimiter,
  validate(customerOtpVerifySchema),
  verifyCustomerOtp
);
// refreshLimiter, not the global apiLimiter: a page that burns through the API
// budget must still be able to restore its session (see rateLimiter.js).
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', authenticate, logout);

export default router;
