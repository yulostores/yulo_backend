import { Router } from 'express';
import { getCashInHandHandler, getEarningsHandler, getPayoutsHandler } from '../../controllers/partner/earnings.controller.js';
import { authenticatePartner } from '../../middleware/authenticatePartner.js';

const router = Router();

router.use(authenticatePartner);

router.get('/cash-in-hand', getCashInHandHandler);
// The rider's weekly payouts: pending, or paid with the date and the transfer reference.
router.get('/payouts', getPayoutsHandler);
router.get('/', getEarningsHandler);

export default router;
