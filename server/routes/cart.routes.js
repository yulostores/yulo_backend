import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { authorizeRole } from '../middleware/authorizeRole.js';
import { validate } from '../middleware/validate.js';
import {
  getCart,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  applyPromo,
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

router.get('/', getCart);
router.post('/items', validate(addItemSchema), addItem);
router.patch('/items/:lineItemId', validate(updateItemSchema), updateItem);
router.delete('/items/:lineItemId', removeItem);
router.delete('/', clearCart);
router.post('/apply-promo', validate(applyPromoSchema), applyPromo);

export default router;
