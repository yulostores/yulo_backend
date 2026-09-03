import { Router } from 'express';
import { list, updateStatus } from '../../controllers/owner/request.controller.js';

const router = Router({ mergeParams: true });

router.get('/', list);
router.patch('/:id', updateStatus);

export default router;
