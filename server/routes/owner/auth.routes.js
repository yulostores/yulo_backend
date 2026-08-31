import { Router } from 'express';
import { z } from 'zod';
import { ownerSignup, ownerLogin, ownerLogout } from '../../controllers/owner/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/signup', authLimiter, validate(signupSchema), ownerSignup);
router.post('/login', authLimiter, validate(loginSchema), ownerLogin);
router.post('/logout', authenticate, authorizeRole('restaurant_owner'), ownerLogout);

export default router;
