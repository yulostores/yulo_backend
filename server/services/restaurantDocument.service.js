// Serving a restaurant's compliance documents.
//
// These are never linked to Cloudinary directly, for two independent reasons:
//
//  1. They don't work. Cloudinary accounts ship with "Allow delivery of PDF and ZIP files"
//     switched off, so a PDF's own secure_url answers `401 deny or ACL failure`. Signing
//     the delivery URL doesn't lift it and neither does `type: authenticated` — both were
//     measured against this account. Uploading to `raw` does deliver, but Cloudinary
//     serves raw assets as `application/octet-stream`, which a browser downloads instead
//     of rendering, so an <iframe> preview stays blank either way.
//
//  2. They shouldn't. A Cloudinary delivery URL is public to anyone holding it, and these
//     are the owner's FSSAI licence, PAN card and bank statement. "Unguessable" is not an
//     access control. Reading a document goes through the API, so the owner's or admin's
//     own session decides who sees it.
//
// So the bytes are fetched server-side and re-served with the content type actually
// recorded for the file. The caller has already been authorised by the route it came in
// on (owner → authorizeRestaurant, admin → the admin router's role check).

import { Readable } from 'node:stream';
import * as uploadService from './upload.service.js';
import { ApiError } from '../utils/ApiError.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

// Documents predating the `publicId`/`resourceType` fields carry only a URL; both are
// recoverable from it, so old uploads keep working without a backfill.
const cloudinaryIdentity = (doc) => ({
  publicId: doc.publicId ?? uploadService.extractPublicId(doc.url),
  resourceType: doc.resourceType ?? uploadService.extractResourceType(doc.url),
});

// The extension Cloudinary knows the asset by — needed to address it on the download
// endpoint, which takes public id and format separately.
//
// Only whatever the URL actually ends in counts. Guessing "pdf" from the mime type would
// be wrong for the assets this code uploads: those are stored raw and extensionless on
// purpose (see owner/document.controller.js), and asking for `<publicId>.pdf` would then
// address a file that does not exist.
const formatOf = (doc) =>
  (doc.url ?? '').split('?')[0].match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();

/**
 * Streams one document to the client with its real content type, inline.
 *
 * Tries plain delivery first (free, un-rate-limited, and what everything we upload from
 * now on can use), then falls back to an api-key-signed download URL for anything
 * delivery refuses — which is how the PDFs uploaded before this existed are recovered
 * without asking owners to submit them again.
 */
export const streamDocument = async (doc, res) => {
  if (!doc?.url) throw new ApiError(404, 'NOT_FOUND', 'Document not found');

  const { publicId, resourceType } = cloudinaryIdentity(doc);

  let upstream = await fetch(doc.url).catch(() => null);

  if ((!upstream || !upstream.ok) && publicId) {
    const signed = uploadService.signedDownloadUrl({
      publicId,
      format: formatOf(doc),
      resourceType,
    });
    upstream = await fetch(signed).catch(() => null);
  }

  if (!upstream || !upstream.ok || !upstream.body) {
    throw new ApiError(
      502,
      'DOCUMENT_UNAVAILABLE',
      'This document could not be retrieved from storage. Ask the owner to upload it again.'
    );
  }

  // Our own record wins over whatever the CDN labelled it: `raw` assets always come back
  // as application/octet-stream, and serving that to an <iframe> is the difference between
  // a rendered PDF and a download prompt.
  const contentType =
    doc.mimeType ??
    (upstream.headers.get('content-type') !== DEFAULT_CONTENT_TYPE
      ? upstream.headers.get('content-type')
      : null) ??
    DEFAULT_CONTENT_TYPE;

  res.setHeader('Content-Type', contentType);
  // Filename in quotes, and stripped of anything that could break out of the header —
  // the name came from the uploader's filesystem, so it is untrusted input.
  const safeName = (doc.name ?? 'document').replace(/["\r\n\\]/g, '');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  // Private: this is one restaurant's KYC paperwork, and it is fetched with credentials.
  res.setHeader('Cache-Control', 'private, max-age=300');

  Readable.fromWeb(upstream.body).pipe(res);
};
