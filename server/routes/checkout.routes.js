import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { requireCustomerAccount } from '../middleware/requireCustomerAccount.js';
import { getSummary } from '../controllers/checkout.controller.js';

const router = Router();

// This is the "buy" gate: a guest can fill a cart, but checking out needs a real
// account, so requireCustomerAccount runs before the role check — see
// yulostores_customer_app's useCheckout, which already renders any 401 here as its
// existing "sign in to continue" state.
router.use(authenticate, requireCustomerAccount, authorizeRole('customer'));

router.get('/summary', getSummary);

export default router;
