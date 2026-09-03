import { Router } from 'express';
import { upload } from '../../middleware/upload.js';
import { list, create, update, remove, publish, draft } from '../../controllers/owner/discount.controller.js';

const router = Router({ mergeParams: true });

router.get('/', list);
router.post('/', upload('image', 2), create);
router.patch('/:dId', upload('image', 2), update);
router.delete('/:dId', remove);
router.patch('/:dId/publish', publish);
router.patch('/:dId/draft', draft);

export default router;
