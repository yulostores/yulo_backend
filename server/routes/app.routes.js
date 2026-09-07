import { Router } from 'express';
import { getAppConfig, getLegalDoc } from '../controllers/app.controller.js';

const router = Router();

// Public, like /api/cuisines — the customer app reads this before (and without) a session,
// and nothing here is user-specific. The per-user piece, `preferences.preferredLanguage`,
// lives on the authenticated /api/users/me/preferences route.
router.get('/config', getAppConfig);
router.get('/legal/:docId', getLegalDoc);

export default router;
