import { Router } from 'express';
import { authenticateStaff } from '../../middleware/authenticateStaff.js';
import { authorizeStaffRole } from '../../middleware/authorizeStaffRole.js';
import { authorizeStaffRestaurant } from '../../middleware/authorizeStaffRestaurant.js';
import { list, updateStatus } from '../../controllers/staff/request.controller.js';

const router = Router({ mergeParams: true });

router.use(authenticateStaff, authorizeStaffRole('waiter'), authorizeStaffRestaurant);

router.get('/', list);
router.patch('/:id', updateStatus);

export default router;
