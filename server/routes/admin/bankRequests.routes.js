import { Router } from 'express';
import { listBankRequests } from '../../controllers/admin/payoutAccount.controller.js';

// Bank account change requests across restaurants (B12) — the Payouts "Bank requests" tab.
// Deciding one is per store: /api/admin/stores/:id/payout-account/change/*.
const router = Router();

router.get('/', listBankRequests);

export default router;
