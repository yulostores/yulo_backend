import { Router } from 'express';
import {
  listBills,
  getBill,
  markBillPaid,
  releaseBillPayment,
  listOpenTables,
  generateBill,
  editBillItem,
  setBillDiscount,
  setBillServiceCharge,
} from '../../controllers/owner/bill.controller.js';

const router = Router({ mergeParams: true });

router.get('/', listBills);
// Before /:billId so "open-tables" is not read as a bill id.
router.get('/open-tables', listOpenTables);
router.post('/sessions/:sessionId/generate', generateBill);
router.get('/:billId', getBill);
router.post('/:billId/mark-paid', markBillPaid);
router.post('/:billId/release-payment', releaseBillPayment);
// The owner's edits before the bill is paid (services/billEdit.service.js).
router.patch('/:billId/items', editBillItem);
router.put('/:billId/discount', setBillDiscount);
router.put('/:billId/service-charge', setBillServiceCharge);

export default router;
