import { Router } from 'express';
import {
  listOrders,
  listOrdersByTable,
  listPendingOrders,
  getOrder,
  acceptOrder,
  rejectOrder,
} from '../../controllers/owner/order.controller.js';
import { getBillForOrder } from '../../controllers/owner/bill.controller.js';

const router = Router({ mergeParams: true });

router.get('/', listOrders);
// Literal segments must precede '/:orderId', or Express matches them as an order id.
router.get('/by-table', listOrdersByTable);
// The approval inbox — customer orders waiting for the restaurant to accept or reject.
router.get('/pending', listPendingOrders);
router.get('/:orderId', getOrder);
router.patch('/:orderId/accept', acceptOrder);
router.patch('/:orderId/reject', rejectOrder);
// The order -> bill lookup. Lives here rather than under /bills because it is keyed by an
// order id, and it is what lets any order row open the receipt it ended up on.
router.get('/:orderId/bill', getBillForOrder);

export default router;
