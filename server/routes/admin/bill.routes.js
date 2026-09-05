import { Router } from 'express';
import { list, getOne } from '../../controllers/admin/bill.controller.js';

const router = Router();

router.get('/', list);
router.get('/:billId', getOne);

export default router;
