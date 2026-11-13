import { Router } from 'express';
import { sellerRedeemLimiter } from '../../middleware/rateLimiter.js';
import { lookup, redeem, today } from '../../controllers/seller/redeem.controller.js';

// /api/seller/redeem — mounted behind authenticateSeller + requireSellerActive, every role.
const router = Router();

router.post('/lookup', sellerRedeemLimiter, lookup);
router.post('/', sellerRedeemLimiter, redeem);
router.get('/today', today);

export default router;
