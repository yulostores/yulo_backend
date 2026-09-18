import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { searchPlaces, reverse, serviceability } from '../controllers/geo.controller.js';

const router = Router();

// Authenticated but not role-restricted: guest sessions carry real tokens and pick a delivery
// address before they ever sign up, so gating on `authorizeRole('customer')` would break the
// first-run flow. The auth requirement is here to protect HERE transaction spend from anonymous
// abuse, not to express a permission.
router.use(authenticate);

router.get('/autocomplete', searchPlaces);
router.get('/reverse', reverse);
router.get('/serviceability', serviceability);

export default router;
