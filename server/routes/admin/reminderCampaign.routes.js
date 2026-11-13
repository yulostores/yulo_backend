import { Router } from 'express';
import { preview, create, list, detail } from '../../controllers/admin/reminder.controller.js';

// /api/admin/reminder-campaigns — behind the admin router's authenticate + authorizeRole('admin').
const router = Router();

router.post('/preview', preview);
router.post('/', create);
router.get('/', list);
router.get('/:id', detail);

export default router;
