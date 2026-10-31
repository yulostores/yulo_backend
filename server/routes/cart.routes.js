import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { validate } from '../middleware/validate.js';
import { requireCustomerAccount } from '../middleware/requireCustomerAccount.js';
import { isLiveActivityEnabled } from '../config/liveActivity.config.js';
import {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  applyPromo,
  applyOffer,
  removeOffer,
  removePromo,
} from '../controllers/cart.controller.js';

const router = Router();

// Guests can use the cart too — browsing and building an order is fine anonymously;
// checkout is where an account becomes required (see requireCustomerAccount on
// checkout/order/review/support routes).
router.use(authenticate, authorizeRole('customer', 'guest'));

const selectedOptionSchema = z.object({
  optionId: z.string().min(1),
  qty: z.number().int().min(1).optional(),
});

const addItemSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().min(1).default(1),
  selectedOptions: z.array(selectedOptionSchema).optional().default([]),
});

const updateItemSchema = z.object({
  qty: z.number().int().min(0),
});

const applyPromoSchema = z.object({
  code: z.string().min(1),
});

const applyOfferSchema = z.object({
  offerId: z.string().regex(/^[a-f\d]{24}$/i, 'must be an offer id'),
}).strict();

// Personal offers (live customer activity) exist only while the feature is on; off, these two
// routes are skipped and the request ends in the ordinary 404, as if they didn't exist.
const liveActivityOnly = (req, res, next) => (isLiveActivityEnabled() ? next() : next('route'));

router.get('/', getCart);
router.post('/items', validate(addItemSchema), addItem);
router.patch('/items/:lineItemId', validate(updateItemSchema), updateItem);
router.delete('/items/:lineItemId', removeItem);
router.delete('/', clearCart);
router.post('/apply-promo', validate(applyPromoSchema), applyPromo);
router.delete('/promo', removePromo);
router.post('/apply-offer', liveActivityOnly, requireCustomerAccount, validate(applyOfferSchema), applyOffer);
router.delete('/offer', liveActivityOnly, removeOffer);

export default router;
