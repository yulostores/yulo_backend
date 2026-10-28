import { Router } from 'express';
import {
  list,
  create,
  getOne,
  approve,
  reject,
  suspend,
  reactivate,
  update,
  updateLocation,
  updateLiveActivity,
  addNote,
  verifyDocument,
  getDocumentFile,
  remove,
} from '../../controllers/admin/store.controller.js';
import {
  getPayoutAccount,
  revealPayoutAccount,
  verifyPayoutAccount,
  rejectPayoutAccount,
  verifyChangeRequest,
  rejectChangeRequest,
  requestChangeInfo,
} from '../../controllers/admin/payoutAccount.controller.js';

const router = Router();

router.get('/', list);
router.post('/', create);
router.get('/:id', getOne);
router.patch('/:id/approve', approve);
router.patch('/:id/reject', reject);
router.patch('/:id/suspend', suspend);
router.patch('/:id/reactivate', reactivate);
// Before '/:id' so the literal segment is not swallowed by the parameterised route.
router.patch('/:id/location', updateLocation);
// Live customer activity for this store (on top of the server-wide LIVE_ACTIVITY_ENABLED).
router.patch('/:id/live-activity', updateLiveActivity);
// The store's settlement bank account: masked view, audit-logged reveal, verify / reject.
router.get('/:id/payout-account', getPayoutAccount);
router.post('/:id/payout-account/reveal', revealPayoutAccount);
router.patch('/:id/payout-account/verify', verifyPayoutAccount);
router.patch('/:id/payout-account/reject', rejectPayoutAccount);
router.patch('/:id/payout-account/change/verify', verifyChangeRequest);
router.patch('/:id/payout-account/change/reject', rejectChangeRequest);
router.patch('/:id/payout-account/change/request-info', requestChangeInfo);
router.patch('/:id', update);
router.post('/:id/notes', addNote);
router.get('/:id/documents/:docId/file', getDocumentFile);
router.patch('/:id/documents/:docId', verifyDocument);
router.delete('/:id', remove);

export default router;
