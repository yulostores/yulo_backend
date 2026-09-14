import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { requireCustomerAccount } from '../middleware/requireCustomerAccount.js';
import { createTicket, listTickets, getTicket, addMessage } from '../controllers/support.controller.js';

const router = Router();

router.use(authenticate, requireCustomerAccount, authorizeRole('customer'));

router.post('/tickets', createTicket);
router.get('/tickets', listTickets);
router.get('/tickets/:id', getTicket);
router.post('/tickets/:id/messages', addMessage);

export default router;
