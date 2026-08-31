import { Router } from 'express';
import { z } from 'zod';
import { adminLogin, adminLogout } from '../../controllers/admin/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authLimiter } from '../../middleware/rateLimiter.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// No public signup — admin accounts are provisioned via scripts/seedSuperAdmin.js or by an
// existing admin, never via self-registration.
router.post('/login', authLimiter, validate(loginSchema), adminLogin);
router.post('/logout', authenticate, authorizeRole('admin'), adminLogout);

export default router;
