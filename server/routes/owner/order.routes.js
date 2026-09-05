import { Router } from 'express';
import { listOrders, listOrdersByTable, getOrder } from '../../controllers/owner/order.controller.js';
import { getBillForOrder } from '../../controllers/owner/bill.controller.js';

const router = Router({ mergeParams: true });

router.get('/', listOrders);
// Must precede '/:orderId', or Express matches "by-table" as an order id.
router.get('/by-table', listOrdersByTable);
router.get('/:orderId', getOrder);
// The order -> bill lookup. Lives here rather than under /bills because it is keyed by an
// order id, and it is what lets any order row open the receipt it ended up on.
router.get('/:orderId/bill', getBillForOrder);

export default router;
