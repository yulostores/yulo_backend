import { Router } from 'express';
import {
  list,
  getOne,
  users,
  reveal,
  approve,
  reject,
  suspend,
  reactivate,
  documentFile,
  recordManualPayment,
  listSubscriptions,
} from '../../controllers/admin/seller.controller.js';
import { recordManualCredits } from '../../controllers/admin/reminder.controller.js';

// Coupon partners — behind the admin router's authenticate + authorizeRole('admin').
const router = Router();

router.get('/', list);
router.get('/:id', getOne);
router.get('/:id/users', users);
router.post('/:id/reveal', reveal);
router.patch('/:id/approve', approve);
router.patch('/:id/reject', reject);
router.patch('/:id/suspend', suspend);
router.patch('/:id/reactivate', reactivate);
router.get('/:id/documents/:docId/file', documentFile);
router.get('/:id/subscriptions', listSubscriptions);
router.post('/:id/subscriptions/manual', recordManualPayment);
router.post('/:id/sms-credits/manual', recordManualCredits);

export default router;
