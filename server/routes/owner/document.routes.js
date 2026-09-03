import { Router } from 'express';
import { uploadDocument as uploadDocumentFile } from '../../middleware/uploadDocuments.js';
import {
  listDocuments,
  uploadDocument,
  deleteDocument,
  getDocumentFile,
} from '../../controllers/owner/document.controller.js';

const router = Router({ mergeParams: true });

// One file per request under the field name `document`, with the document's `type` in the
// body — the owner portal uploads these one at a time. 5 MB ceiling, JPEG/PNG/WebP/PDF
// only, enforced by the middleware so a bad pick answers 400 rather than reaching Cloudinary.
router.get('/', listDocuments);
// The file itself, streamed through the API rather than linked to Cloudinary — the owner's
// own session is what authorises reading their KYC paperwork back.
router.get('/:docId/file', getDocumentFile);
router.post('/', uploadDocumentFile('document', 5), uploadDocument);
router.delete('/:docId', deleteDocument);

export default router;
