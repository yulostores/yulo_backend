import { Router } from 'express';
import {
  clearPushToken,
  registerPushToken,
  updateNotificationPreferences,
} from '../../controllers/partner/profile.controller.js';
import { authenticatePartner } from '../../middleware/authenticatePartner.js';

const router = Router();

router.use(authenticatePartner);

router.patch('/', updateNotificationPreferences);
router.put('/push-token', registerPushToken);
router.delete('/push-token', clearPushToken);

export default router;
