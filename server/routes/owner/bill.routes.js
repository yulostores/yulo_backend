import { Router } from 'express';
import {
  listBills,
  exportBills,
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
// Before /:billId so "open-tables" / "export.xlsx" are not read as a bill id.
router.get('/open-tables', listOpenTables);
router.get('/export.xlsx', exportBills);
router.post('/sessions/:sessionId/generate', generateBill);
router.get('/:billId', getBill);
router.post('/:billId/mark-paid', markBillPaid);
router.post('/:billId/release-payment', releaseBillPayment);
// The owner's edits before the bill is paid (services/billEdit.service.js).
router.patch('/:billId/items', editBillItem);
router.put('/:billId/discount', setBillDiscount);
router.put('/:billId/service-charge', setBillServiceCharge);

export default router;
