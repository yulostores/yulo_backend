import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  searchRestaurants,
  staffLogin,
  staffLogout,
  staffSession,
} from '../../controllers/staff/auth.controller.js';
import { authenticateStaff } from '../../middleware/authenticateStaff.js';
import { staffOtpLimiter } from '../../middleware/rateLimiter.js';
import { normalizeIndianPhone as normalizePhoneKey } from '../../utils/phone.js';
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

const loginSchema = z.object({
  restaurantId: restaurantIdField,
  phone: phoneField,
  pin: z.string().trim().regex(/^\d{4}$/, 'Enter your 4-digit PIN'),
});

// A 4-digit PIN has 10 000 values, so guesses are capped per number at each restaurant (on
// top of the per-IP staffOtpLimiter): 5 tries, then wait 15 minutes.
const pinGuessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `staff-pin:${req.body?.restaurantId}:${normalizePhoneKey(req.body?.phone) ?? req.body?.phone}`,
  skipSuccessfulRequests: true,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many wrong PINs — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public — the picker has to work before any token exists.
router.get('/restaurants', typeaheadLimiter, searchRestaurants);

// Phone + PIN (set by the owner). Replaces the earlier phone + OTP login.
router.post('/login', staffOtpLimiter, validate(loginSchema), pinGuessLimiter, staffLogin);
router.get('/me', authenticateStaff, staffSession);
router.post('/logout', authenticateStaff, staffLogout);

export default router;
