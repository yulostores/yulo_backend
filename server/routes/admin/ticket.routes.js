import { Router } from 'express';
import {
  list,
  counts,
  getOne,
  update,
  addMessage,
  requestInformation,
  getAttachment,
} from '../../controllers/admin/ticket.controller.js';
import { uploadDocument } from '../../middleware/uploadDocuments.js';
import { ATTACHMENT_MAX_MB } from '../../services/supportTicket.service.js';

const router = Router();

// One optional file per reply (`attachment`): PDF / JPG / PNG, 5 MB — the type is re-checked in
// the service (the shared middleware also allows WebP).
const attachment = uploadDocument('attachment', ATTACHMENT_MAX_MB);

router.get('/', list);
router.get('/counts', counts);
router.get('/:id', getOne);
router.patch('/:id', update);
router.post('/:id/messages', attachment, addMessage);
router.post('/:id/request-information', attachment, requestInformation);
router.get('/:id/attachments/:attachmentId', getAttachment);

export default router;
