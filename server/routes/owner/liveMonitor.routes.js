import { Router } from 'express';
import { getStats, getActiveVisitors, getRepeatVisitors } from '../../controllers/owner/liveMonitor.controller.js';

const router = Router({ mergeParams: true });

router.get('/', getStats);
router.get('/visitors', getActiveVisitors);
router.get('/repeat', getRepeatVisitors);

export default router;
