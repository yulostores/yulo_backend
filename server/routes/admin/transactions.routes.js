import { Router } from 'express';
import { list, summary, exportXlsx } from '../../controllers/admin/transactions.controller.js';

const router = Router();

router.get('/', list);
router.get('/summary', summary);
router.get('/export.xlsx', exportXlsx);

export default router;
