import { Router } from 'express';
import * as jobs from '../../controllers/admin/jobApplication.controller.js';

// Super admin — careers portal applications (services/jobApplication.service.js).
const router = Router();

router.get('/', jobs.list);
router.get('/export.csv', jobs.exportCsv);
router.get('/:id', jobs.getOne);
router.patch('/:id/status', jobs.setStatus);
router.post('/:id/notes', jobs.addNote);
router.get('/:id/resume', jobs.resumeFile);

export default router;
