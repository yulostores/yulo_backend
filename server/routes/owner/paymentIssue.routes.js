import { Router } from 'express';
import { create, list, detail, addMessage, getAttachment } from '../../controllers/owner/paymentIssue.controller.js';
import { uploadDocument } from '../../middleware/uploadDocuments.js';
import { ATTACHMENT_MAX_MB } from '../../services/supportTicket.service.js';

// Mounted at /api/owner/:restaurantId/payment-issues (routes/owner/index.js). Money talk — never
// cached by a browser or proxy.
const router = Router({ mergeParams: true });

router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// One optional file per report / message (`attachment`): PDF / JPG / PNG, 5 MB.
const attachment = uploadDocument('attachment', ATTACHMENT_MAX_MB);

router.post('/', attachment, create);
router.get('/', list);
router.get('/:ticketId', detail);
router.post('/:ticketId/messages', attachment, addMessage);
router.get('/:ticketId/attachments/:attachmentId', getAttachment);

export default router;
