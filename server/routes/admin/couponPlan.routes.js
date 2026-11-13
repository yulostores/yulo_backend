import { Router } from 'express';
import { list, update } from '../../controllers/admin/couponPlan.controller.js';

// Behind the admin router's authenticate + authorizeRole('admin').
const router = Router();

router.get('/', list);
router.put('/:key', update);

export default router;
