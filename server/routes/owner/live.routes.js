import { Router } from 'express';
import { isLiveActivityEnabledFor } from '../../config/liveActivity.config.js';
import { liveOfferLimiter } from '../../middleware/rateLimiter.js';
import {
  listSessions,
  getSession,
  listSessionEvents,
  createOffer,
  revokeOffer,
  listOffers,
  getMetrics,
} from '../../controllers/owner/live.controller.js';

// /api/owner/:restaurantId/live — mounted inside the owner's restaurant-scoped router, so
// authenticate, restaurant_owner, authorizeRestaurant and requireRestaurantApproved have run.
const router = Router({ mergeParams: true });

// With the feature off (or this restaurant outside the pilot) the whole router is skipped, so
// the request falls through to the app's ordinary 404 — exactly as if these routes didn't exist.
router.use((req, _res, next) => (isLiveActivityEnabledFor(req.restaurant._id) ? next() : next('router')));

router.get('/sessions', listSessions);
router.get('/sessions/:sessionId', getSession);
router.get('/sessions/:sessionId/events', listSessionEvents);
router.post('/offers', liveOfferLimiter, createOffer);
router.post('/offers/:offerId/revoke', revokeOffer);
router.get('/offers', listOffers);
router.get('/metrics', getMetrics);

export default router;
