import { Router } from 'express';
import { list, create, update, submit, pause, resume } from '../../controllers/seller/offer.controller.js';

// Mounted behind authenticateSeller + requireSellerActive + owner/manager (routes/seller/index.js).
const router = Router();

router.get('/', list);
router.post('/', create);
router.patch('/:id', update);
router.post('/:id/submit', submit);
router.post('/:id/pause', pause);
router.post('/:id/resume', resume);

export default router;
