// Compliance documents an owner uploads to get (and stay) approved — the scanned
// counterparts to the numbers captured in `settings` (FSSAI/GST/PAN/registration).
//
// Admin has always had a documents panel (super admin → Store Detail) with a
// verify/reject control per document, and `Restaurant.documents` to read it from, but
// nothing anywhere wrote to that array for a restaurant: the array was only ever
// populated for delivery partners. These three endpoints are the owner-facing half —
// they are what makes that panel show something other than "0/6 uploaded".
//
// Deliberately outside `requireRestaurantApproved` (routes/owner/index.js): uploading
// these IS how a pending restaurant gets approved, so locking them behind approval would
// be circular.
import Restaurant from '../../models/Restaurant.js';
import * as uploadService from '../../services/upload.service.js';
import { streamDocument } from '../../services/restaurantDocument.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';

// Must stay in step with the `type` enum on restaurantDocumentSchema (models/Restaurant.js)
// and with STORE_DOCUMENT_TYPES in the super admin portal (src/lib/constants.js) — the
// three lists are the same set of documents seen from the schema, the owner and the
// reviewer. Validated here rather than left to the schema enum so an unknown type is a
// 400 with a usable message instead of a mongoose ValidationError after a wasted upload.
export const DOCUMENT_TYPES = [
  'fssai_license',
  'business_registration',
  'gst_certificate',
  'pan_card',
  'address_proof',
  'bank_statement',
];

export const listDocuments = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Documents', { documents: req.restaurant.documents ?? [] });
});

export const uploadDocument = asyncHandler(async (req, res) => {
  const { type } = req.body;
  if (!DOCUMENT_TYPES.includes(type)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `type must be one of: ${DOCUMENT_TYPES.join(', ')}`
    );
  }
  if (!req.file) throw new ApiError(400, 'VALIDATION_ERROR', 'No document file was provided');

  // Re-read rather than trusting req.restaurant: the document array is what we are about to
  // rewrite, and the copy authorizeRestaurant loaded may be a request or two stale.
  const restaurant = await Restaurant.findById(req.restaurant._id);
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  const existing = restaurant.documents.find((d) => d.type === type);
  // A verified document is settled evidence — admin has already checked it, and the
  // approval decision may rest on it. Swapping the file underneath that verdict while the
  // status still reads "verified" is exactly the hole this guard closes; correcting one is
  // a support event, the same rule the compliance *numbers* follow once saved.
  if (existing?.status === 'verified') {
    throw new ApiError(
      409,
      'DOCUMENT_VERIFIED',
      'This document has already been verified and can only be replaced by platform support'
    );
  }

  // PDFs go to `raw`, not `image`/`auto`. Cloudinary files a PDF under the `image`
  // resource type, where it is governed by the account's "Allow delivery of PDF and ZIP
  // files" switch — off by default, and every request for such a file then comes back
  // `401 deny or ACL failure`. `raw` is outside that ACL. Nothing links to these URLs
  // directly anyway (see services/restaurantDocument.service.js), but an asset the API
  // itself cannot read back is worth avoiding.
  const resourceType = req.file.mimetype === 'application/pdf' ? 'raw' : 'image';

  let uploaded;
  try {
    uploaded = await uploadService.uploadBuffer({
      buffer: req.file.buffer,
      folder: `yulostores/restaurants/${restaurant._id}/documents`,
      // Deliberately no file extension. Cloudinary's PDF block keys on the *extension* of
      // the delivery URL, not on the resource type — measured: a raw asset ending `.pdf`
      // is refused exactly like an image one, while the same bytes at an extensionless raw
      // URL serve fine. `raw` uses the public id verbatim, so leaving the extension off is
      // enough to stay outside the ACL. The real content type is recorded on the document
      // and reapplied when it is served, so nothing downstream needs the URL to carry it.
      publicId: `${type}_${Date.now()}`,
      resourceType,
    });
  } catch (uploadErr) {
    // Cloudinary's own wording ("Invalid image file", "Resource not found in this account")
    // is meaningless to a restaurant owner and reads as the app being broken. It goes to
    // the log, under the request id, and the owner gets something they can act on.
    logger.error(
      {
        reqId: req.id,
        restaurantId: restaurant._id?.toString(),
        documentType: type,
        resourceType,
        mimeType: req.file.mimetype,
        size: req.file.size,
        err: uploadErr?.message ?? String(uploadErr),
      },
      'Compliance document upload to storage failed'
    );
    throw new ApiError(
      502,
      'UPLOAD_FAILED',
      'Sorry, we could not save that document right now. Please try again in a moment.'
    );
  }

  // Replace in place, never append: a resubmission after rejection must overwrite the entry
  // for its type — two documents of the same type would leave admin verifying whichever one
  // their UI happened to find first (both portals look documents up by `type`).
  //
  // Status resets to 'pending' with the new file, so a previously rejected document
  // re-enters review rather than staying red with a fresh file behind it.
  const replaced = existing
    ? {
        publicId: existing.publicId ?? uploadService.extractPublicId(existing.url),
        resourceType: existing.resourceType ?? uploadService.extractResourceType(existing.url),
      }
    : null;
  restaurant.documents = restaurant.documents
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
    await restaurant.save();
  } catch (err) {
    // Roll the orphan back — the owner sees a failure and no file should survive it.
    await uploadService.deleteAsset(uploaded.publicId, resourceType).catch(() => {});
    throw err;
  }

  // Only once the write is safely down: best-effort reaping of the superseded asset, so a
  // re-upload doesn't leak the previous file in Cloudinary forever. Matches the brand-image
  // handling in owner/settings.controller.js.
  if (replaced?.publicId) {
    await uploadService.deleteAsset(replaced.publicId, replaced.resourceType).catch(() => {});
  }

  sendSuccess(res, 200, 'Document uploaded', { documents: restaurant.documents });
});

export const deleteDocument = asyncHandler(async (req, res) => {
  const restaurant = await Restaurant.findById(req.restaurant._id);
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');

  const doc = restaurant.documents.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  if (doc.status === 'verified') {
    throw new ApiError(
      409,
      'DOCUMENT_VERIFIED',
      'A verified document can only be removed by platform support'
    );
  }

  const publicId = doc.publicId ?? uploadService.extractPublicId(doc.url);
  const resourceType = doc.resourceType ?? uploadService.extractResourceType(doc.url);
  doc.deleteOne();
  await restaurant.save();

  if (publicId) await uploadService.deleteAsset(publicId, resourceType).catch(() => {});

  sendSuccess(res, 200, 'Document removed', { documents: restaurant.documents });
});

// The bytes themselves. Never a Cloudinary link — see
// services/restaurantDocument.service.js for why neither portal is given one.
export const getDocumentFile = asyncHandler(async (req, res) => {
  const doc = req.restaurant.documents?.id(req.params.docId);
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  await streamDocument(doc, res);
});
