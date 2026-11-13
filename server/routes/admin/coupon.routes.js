import { Router } from 'express';
import {
  listCategories,
  createCategory,
  updateCategory,
  listOffers,
  approveOffer,
  rejectOffer,
} from '../../controllers/admin/coupon.controller.js';

// Behind the admin router's authenticate + authorizeRole('admin'). Mounted twice in
// routes/admin/index.js: the category routes at /coupon-categories, the offer routes at
// /coupon-offers.
export const categoryRouter = Router();
categoryRouter.get('/', listCategories);
categoryRouter.post('/', createCategory);
categoryRouter.patch('/:id', updateCategory);

export const offerRouter = Router();
offerRouter.get('/', listOffers);
offerRouter.patch('/:id/approve', approveOffer);
offerRouter.patch('/:id/reject', rejectOffer);
