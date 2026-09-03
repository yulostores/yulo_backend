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
import { authLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';

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

const loginSchema = z.object({
  restaurantId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid restaurant'),
  // Owner-assigned codes are one letter plus two digits (W01, C02) — see
  // controllers/owner/staff.controller.js. Kept loose enough for a longer scheme later,
  // strict enough to reject a name typed into the wrong box.
  staffCode: z.string().trim().min(2).max(10),
  pin: z.string().trim().regex(/^\d{4,8}$/, 'PIN must be 4-8 digits'),
});

// Public — the picker has to work before any token exists.
router.get('/restaurants', typeaheadLimiter, searchRestaurants);

router.post('/login', authLimiter, validate(loginSchema), staffLogin);
router.get('/me', authenticateStaff, staffSession);
router.post('/logout', authenticateStaff, staffLogout);

export default router;
