import { Router } from 'express';
import { z } from 'zod';
import { ownerSignup, ownerLogin, ownerLogout } from '../../controllers/owner/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';
import { normalizeIndianPhone } from '../../utils/phone.js';

const router = Router();

// The owner's mobile number is their login. Accepts "+91 98765 43210", "098765-43210" etc. and
// hands the controller the one stored shape (10 digits) — see utils/phone.js.
const mobileSchema = z
  .string()
  .transform((v, ctx) => {
    const phone = normalizeIndianPhone(v);
    if (!phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit mobile number' });
      return z.NEVER;
    }
    return phone;
  });

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
  phone: mobileSchema,
});

const loginSchema = z.object({
  phone: mobileSchema,
  password: z.string().min(1),
});

router.post('/signup', authLimiter, validate(signupSchema), ownerSignup);
router.post('/login', authLimiter, validate(loginSchema), ownerLogin);
router.post('/logout', authenticate, authorizeRole('restaurant_owner'), ownerLogout);

export default router;
