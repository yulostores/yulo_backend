import { Router } from 'express';
import { list, add, edit, remove } from '../../controllers/seller/team.controller.js';

// /api/seller/users — mounted behind authenticateSeller + requireSellerActive + owner/manager.
// What each role may do to whom is decided in services/sellerTeam.service.js.
const router = Router();

router.get('/', list);
router.post('/', add);
router.patch('/:id', edit);
router.delete('/:id', remove);

export default router;
