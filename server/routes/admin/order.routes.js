import { Router } from 'express';
import { cancelOrder, markDelivered, reassignDeliveryPartner } from '../../controllers/admin/order.controller.js';

const router = Router();

router.patch('/:id/delivery-partner', reassignDeliveryPartner);
router.patch('/:id/cancel', cancelOrder);
router.patch('/:id/mark-delivered', markDelivered);

export default router;
