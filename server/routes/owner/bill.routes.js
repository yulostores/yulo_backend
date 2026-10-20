import { Router } from 'express';
import { listBills, getBill, markBillPaid, releaseBillPayment } from '../../controllers/owner/bill.controller.js';

const router = Router({ mergeParams: true });

router.get('/', listBills);
router.get('/:billId', getBill);
router.post('/:billId/mark-paid', markBillPaid);
router.post('/:billId/release-payment', releaseBillPayment);

export default router;
