import { Router } from 'express';
import { uploadDocument as uploadDocumentFile } from '../../middleware/uploadDocuments.js';
import {
  getOnboarding,
  putBusiness,
  putOwner,
  putEmployees,
  submitOnboarding,
  uploadDocument,
  deleteDocument,
  getDocumentFile,
} from '../../controllers/seller/onboarding.controller.js';

// Mounted behind authenticateSeller + authorizeSellerRole('owner') (routes/seller/index.js).
// Bodies are validated in services/sellerOnboarding.service.js, which also decides what is
// locked for an approved seller — the schema depends on the seller's status.
const router = Router();

router.get('/', getOnboarding);
router.put('/business', putBusiness);
router.put('/owner', putOwner);
router.put('/employees', putEmployees);
router.post('/submit', submitOnboarding);
router.post('/documents', uploadDocumentFile('document', 5), uploadDocument);
router.get('/documents/:docId/file', getDocumentFile);
router.delete('/documents/:docId', deleteDocument);

export default router;
