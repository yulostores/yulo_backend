import { Router } from 'express';
import { z } from 'zod';
import { ownerSignup, ownerLogin, ownerLogout } from '../../controllers/owner/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

// Keep the name / phone / password rules in step with OwnerLoginPage.jsx in yulo_restaurant.
const signupSchema = z.object({
  name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(60, 'Full name must be at most 60 characters'),
  email: z.string().email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(64, 'Password must be at most 64 characters')
    .regex(/[a-z]/, 'Password needs a lowercase letter')
    .regex(/[A-Z]/, 'Password needs an uppercase letter')
    .regex(/\d/, 'Password needs a number')
    .regex(/[^A-Za-z0-9]/, 'Password needs a special character'),
  phone: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
    .optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/signup', authLimiter, validate(signupSchema), ownerSignup);
router.post('/login', authLimiter, validate(loginSchema), ownerLogin);
router.post('/logout', authenticate, authorizeRole('restaurant_owner'), ownerLogout);

export default router;
