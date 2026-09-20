import { Router } from 'express';
import {
  list,
  create,
  getOne,
  approve,
  reject,
  suspend,
  reactivate,
  update,
  updateLocation,
  addNote,
  verifyDocument,
  getDocumentFile,
  remove,
} from '../../controllers/admin/store.controller.js';

const router = Router();

router.get('/', list);
router.post('/', create);
router.get('/:id', getOne);
router.patch('/:id/approve', approve);
router.patch('/:id/reject', reject);
router.patch('/:id/suspend', suspend);
router.patch('/:id/reactivate', reactivate);
// Before '/:id' so the literal segment is not swallowed by the parameterised route.
router.patch('/:id/location', updateLocation);
router.patch('/:id', update);
router.post('/:id/notes', addNote);
router.get('/:id/documents/:docId/file', getDocumentFile);
router.patch('/:id/documents/:docId', verifyDocument);
router.delete('/:id', remove);

export default router;
