import Seller from '../../models/Seller.js';
import * as uploadService from '../../services/upload.service.js';
import * as onboarding from '../../services/sellerOnboarding.service.js';
import { streamDocument } from '../../services/restaurantDocument.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';

// The owner's onboarding form (services/sellerOnboarding.service.js holds the rules). Owner-only,
// and deliberately NOT behind requireSellerActive: filling this in is how a pending seller gets
// approved.

/** GET /api/seller/onboarding */
export const getOnboarding = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Onboarding', await onboarding.onboardingView(req.seller.sellerId));
});

/** PUT /api/seller/onboarding/business */
export const putBusiness = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Business details saved', await onboarding.saveBusiness(req.seller.sellerId, req.body));
});

/** PUT /api/seller/onboarding/owner */
export const putOwner = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Owner details saved', await onboarding.saveOwner(req.seller.sellerId, req.body));
});

/** PUT /api/seller/onboarding/employees */
export const putEmployees = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Team saved', await onboarding.saveEmployees(req.seller.sellerId, req.body));
});

/** POST /api/seller/onboarding/submit */
export const submitOnboarding = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Sent for review', await onboarding.submit(req.seller.sellerId));
});

/** GET /api/seller/status — any role, any seller status. */
export const getStatus = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Status', await onboarding.statusView(req.seller.sellerId));
});

// ── Documents ─────────────────────────────────────────────────────────────────
// The restaurant compliance-document pipeline (controllers/owner/document.controller.js), for a
// seller: one file per request under the field `document`, its `type` in the body; PDFs stored
// as extensionless `raw` assets; one document per type, replaced in place; files read back only
// through the API.

/**
 * POST /api/seller/onboarding/documents  multipart: document=<file>, type=<SELLER_DOCUMENT_TYPES>
 */
export const uploadDocument = asyncHandler(async (req, res) => {
  const { type } = req.body ?? {};
  onboarding.assertDocumentType(type);
  if (!req.file) throw new ApiError(400, 'VALIDATION_ERROR', 'No document file was provided');

  const seller = await Seller.findById(req.seller.sellerId);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  onboarding.assertDocumentsEditable(seller);

  const existing = seller.documents.find((d) => d.type === type);
  if (existing?.status === 'verified') {
    throw new ApiError(409, 'DOCUMENT_VERIFIED', 'This document has already been verified and can only be replaced by Yulo support');
  }

  const resourceType = req.file.mimetype === 'application/pdf' ? 'raw' : 'image';
  let uploaded;
  try {
    uploaded = await uploadService.uploadBuffer({
      buffer: req.file.buffer,
      folder: `yulostores/sellers/${seller._id}/documents`,
      // No extension, for the reason given in controllers/owner/document.controller.js.
      publicId: `${type}_${Date.now()}`,
      resourceType,
    });
  } catch (uploadErr) {
    logger.error(
      {
        reqId: req.id,
        sellerId: seller._id?.toString(),
        documentType: type,
        resourceType,
        mimeType: req.file.mimetype,
        size: req.file.size,
        err: uploadErr?.message ?? String(uploadErr),
      },
      'Seller document upload to storage failed'
    );
    throw new ApiError(502, 'UPLOAD_FAILED', 'Sorry, we could not save that document right now. Please try again in a moment.');
  }

  const replaced = existing ? { publicId: existing.publicId, resourceType: existing.resourceType } : null;
  seller.documents = seller.documents
    .filter((d) => d.type !== type)
    .concat({
      type,
      url: uploaded.secureUrl,
      name: req.file.originalname,
      mimeType: req.file.mimetype,
      publicId: uploaded.publicId,
      resourceType,
      status: 'pending',
      uploadedAt: new Date(),
    });
  try {
    await seller.save();
  } catch (err) {
    await uploadService.deleteAsset(uploaded.publicId, resourceType).catch(() => {});
    throw err;
  }
  if (replaced?.publicId) await uploadService.deleteAsset(replaced.publicId, replaced.resourceType).catch(() => {});

  sendSuccess(res, 200, 'Document uploaded', { documents: seller.documents.map(onboarding.toDocumentView) });
});

/** DELETE /api/seller/onboarding/documents/:docId */
export const deleteDocument = asyncHandler(async (req, res) => {
  const seller = await Seller.findById(req.seller.sellerId);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  onboarding.assertDocumentsEditable(seller);

  const doc = seller.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  if (doc.status === 'verified') {
    throw new ApiError(409, 'DOCUMENT_VERIFIED', 'A verified document can only be removed by Yulo support');
  }
  const { publicId, resourceType } = doc;
  doc.deleteOne();
  await seller.save();
  if (publicId) await uploadService.deleteAsset(publicId, resourceType).catch(() => {});

  sendSuccess(res, 200, 'Document removed', { documents: seller.documents.map(onboarding.toDocumentView) });
});

/** GET /api/seller/onboarding/documents/:docId/file — the bytes, streamed through the API. */
export const getDocumentFile = asyncHandler(async (req, res) => {
  const seller = await Seller.findById(req.seller.sellerId).select('documents').lean();
  const doc = seller?.documents?.find((d) => String(d._id) === req.params.docId);
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  await streamDocument(doc, res);
});
