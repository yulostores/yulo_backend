import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  searchRestaurants,
  sendStaffOtp,
  verifyStaffOtp,
  staffLogout,
  staffSession,
} from '../../controllers/staff/auth.controller.js';
import { authenticateStaff } from '../../middleware/authenticateStaff.js';
import { staffOtpLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';
import { normalizeIndianPhone } from '../../utils/phone.js';

const router = Router();

// Typeahead fires per keystroke (debounced client-side), so authLimiter's 10/min budget
// would cut a staff member off mid-word. It is a read-only, projection-limited query —
// give it a budget sized for typing, not for guessing credentials.
const typeaheadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many searches' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

const restaurantIdField = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid restaurant');

// Accepts "+91 98765 43210", "09876543210" or "9876543210" and hands the controller the
// bare 10 digits the owner's record stores (utils/phone.js).
const phoneField = z.preprocess(
  (v) => normalizeIndianPhone(v) ?? v,
  z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
);

const sendOtpSchema = z.object({ restaurantId: restaurantIdField, phone: phoneField });

const verifyOtpSchema = z.object({
  restaurantId: restaurantIdField,
  phone: phoneField,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

// Public — the picker has to work before any token exists.
router.get('/restaurants', typeaheadLimiter, searchRestaurants);

// Phone + OTP. The PIN login (POST /login) is gone — see controllers/staff/auth.controller.js.
router.post('/otp/send', staffOtpLimiter, validate(sendOtpSchema), sendStaffOtp);
router.post('/otp/verify', staffOtpLimiter, validate(verifyOtpSchema), verifyStaffOtp);
router.get('/me', authenticateStaff, staffSession);
router.post('/logout', authenticateStaff, staffLogout);

export default router;
