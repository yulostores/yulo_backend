import { Router } from 'express';
import { demographics, trends, coupons, couponsCsv } from '../../controllers/seller/reports.controller.js';

// /api/seller/reports — mounted behind authenticateSeller + requireSellerActive + owner/manager.
const router = Router();

router.get('/demographics', demographics);
router.get('/trends', trends);
router.get('/coupons', coupons);
router.get('/coupons.csv', couponsCsv);

export default router;
