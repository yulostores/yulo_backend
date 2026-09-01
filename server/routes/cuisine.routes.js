import { Router } from 'express';
import { listCuisines } from '../controllers/cuisine.controller.js';

const router = Router();

// Public, like the restaurant listing it is derived from — cuisines are already printed
// on every public restaurant card. No auth, so the owner portal's store-settings form and
// the customer app's filters can both read the same vocabulary.
router.get('/', listCuisines);

export default router;
