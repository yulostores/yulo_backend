import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { isLiveActivityEnabled } from '../config/liveActivity.config.js';
import { listMine, markViewed } from '../controllers/offer.controller.js';

// /api/offers — a customer's personal offers (live customer activity). Applying one to the cart
// is POST /api/cart/apply-offer.
const router = Router();

// Off: skipped entirely — before authentication — so every request gets the app's ordinary
// 404, exactly as when this router didn't exist.
router.use((req, res, next) => (isLiveActivityEnabled() ? next() : next('router')));
router.use(authenticate, authorizeRole('customer', 'guest'));

router.get('/mine', listMine);
router.post('/:offerId/viewed', markViewed);

export default router;
