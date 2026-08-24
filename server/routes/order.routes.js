import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import {
  createOrder,
  checkout,
  verifyPayment,
  simulatePayment,
  listOrders,
  getOrder,
  getTracking,
  reorder,
  getVegFleetStatus,
  keepWaitingVegFleet,
  fallbackVegFleet,
} from '../controllers/order.controller.js';

const router = Router();

router.use(authenticate, authorizeRole('customer'));

router.post('/', createOrder);
router.post('/checkout', checkout);
router.post('/:id/payment/verify', verifyPayment);
router.post('/:id/payment/simulate', simulatePayment);
router.get('/', listOrders);
router.get('/:id', getOrder);
router.get('/:id/tracking', getTracking);
router.post('/:id/reorder', reorder);

router.get('/:id/veg-fleet/status', getVegFleetStatus);
router.post('/:id/veg-fleet/keep-waiting', keepWaitingVegFleet);
router.post('/:id/veg-fleet/fallback', fallbackVegFleet);

export default router;
