import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { requireCustomerAccount } from '../middleware/requireCustomerAccount.js';
import { createReview } from '../controllers/review.controller.js';

const router = Router();

router.post(
  '/:orderId/review',
  authenticate,
  requireCustomerAccount,
  authorizeRole('customer'),
  createReview
);

export default router;
