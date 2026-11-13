import { Router } from 'express';
import { detail, exportCsv, list, pdf } from '../../controllers/admin/sellerBill.controller.js';

// Mounted at /api/admin/seller-bills (admin-only: routes/admin/index.js authenticates first).
const router = Router();
router.get('/', list);
router.get('/export.csv', exportCsv);
router.get('/:id', detail);
router.get('/:id/pdf', pdf);
export default router;
