import { Router } from 'express';
import { cancelOrder, reassignDeliveryPartner } from '../../controllers/admin/order.controller.js';

const router = Router();

router.patch('/:id/delivery-partner', reassignDeliveryPartner);
router.patch('/:id/cancel', cancelOrder);

export default router;
