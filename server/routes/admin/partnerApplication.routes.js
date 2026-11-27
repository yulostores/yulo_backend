import { Router } from 'express';
import * as partners from '../../controllers/admin/partnerApplication.controller.js';

// Super admin — "Choose your business" applications (services/partnerApplication.service.js).
const router = Router();

router.get('/', partners.list);
router.get('/export.csv', partners.exportCsv);
router.get('/:id', partners.getOne);
router.patch('/:id/status', partners.setStatus);
router.post('/:id/notes', partners.addNote);
router.post('/:id/call', partners.markCalled);
router.patch('/:id/interest', partners.setInterest);
router.delete('/:id', partners.remove);

export default router;
