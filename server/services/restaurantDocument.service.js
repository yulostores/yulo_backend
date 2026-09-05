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
import { pipeline } from 'node:stream/promises';
import * as uploadService from './upload.service.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

// Nothing on this path may outlive the platform's gateway timeout. An upstream that stalls
// used to sit in `fetch` until undici's own 300s headers/body timeout — five times the 60s
// DigitalOcean gives a request — so one unresponsive Cloudinary connection reached the
// portal as a bare `504 Gateway Timeout`, with no log line and nothing to tell it apart
// from the API being down. Bounded here instead, and with both attempts together still
// well inside the gateway's budget.
const UPSTREAM_TIMEOUT_MS = 15_000;

// What the person on the other end is told. Deliberately free of status codes, hostnames
// and the word "Cloudinary": a restaurant owner cannot act on any of that, and a reviewer
// reading "502 DOCUMENT_UNAVAILABLE" learns nothing they can do either. The detail that
// actually diagnoses the failure goes to the log instead, under the request id, where
// support can find it.
const MESSAGES = {
  // Storage answered, and answered "there is nothing here" — the file is genuinely gone,
  // and no amount of retrying brings it back. Say the one thing that fixes it.
  gone: 'This document is no longer available. Please upload it again.',
  // Anything else: a timeout, a refusal, a 5xx. Transient as far as the caller is
  // concerned, so the honest instruction is to try again.
  unavailable: 'Sorry, this document could not be previewed right now. Please try again in a moment.',
};

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

// A PDF filed under the `image` resource type sits behind the account's PDF-delivery
// switch and answers 401 every single time (reason 1 above). Every document uploaded
// before this controller started using `raw` is shaped that way, so attempting delivery
// for one is a guaranteed-wasted round trip — and it is that round trip, to a different
// host from the fallback, that was hanging. Go straight to the download endpoint instead.
//
// scripts/migrateRestaurantDocumentAssets.js moves those legacy assets onto `raw`, after
// which nothing takes this branch; it stays because a document restored from an old
// backup would otherwise 401 its way back to square one.
const deliveryIsPossible = (doc, resourceType, format) =>
  !(resourceType === 'image' && (format === 'pdf' || doc.mimeType === 'application/pdf'));

// One upstream attempt: bounded, and it cleans up after itself. Returns the response only
// if it is usable, else null plus a record of what went wrong for the caller to log.
//
// A rejected response has its body explicitly cancelled — an undici response whose body is
// neither read nor cancelled holds its socket open until the GC gets to it, and the old
// code produced one of those on every single PDF view.
const fetchUpstream = async (url, label) => {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    // A TimeoutError here is the interesting one: it means the request went out and
    // Cloudinary never answered, which is what an unroutable egress path looks like from
    // inside the container.
    return { response: null, attempt: { via: label, error: err?.name ?? String(err) } };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { response: null, attempt: { via: label, status: response.status } };
  }
  return { response, attempt: { via: label, status: response.status } };
};

/**
 * Streams one document to the client with its real content type, inline.
 *
 * Tries plain delivery first (free, un-rate-limited, and what everything we upload from
 * now on can use), then falls back to an api-key-signed download URL for anything
 * delivery refuses — which is how the PDFs uploaded before this existed are recovered
 * without asking owners to submit them again.
 *
 * @param {object} doc the `documents` subdocument to serve
 * @param {import('express').Response} res
 */
export const streamDocument = async (doc, res) => {
  if (!doc?.url) throw new ApiError(404, 'NOT_FOUND', 'Document not found');

  const { publicId, resourceType } = cloudinaryIdentity(doc);
  const format = formatOf(doc);
  // Everything support needs to identify one specific failure. `reqId` is pino-http's, so
  // a report of "it says try again" can be tied to the exact request that said it.
  const context = {
    reqId: res.req?.id,
    documentId: doc._id?.toString(),
    documentType: doc.type,
    publicId,
    resourceType,
    format,
  };
  const attempts = [];

  let upstream = null;
  if (deliveryIsPossible(doc, resourceType, format)) {
    const result = await fetchUpstream(doc.url, 'delivery');
    attempts.push(result.attempt);
    upstream = result.response;
  } else {
    attempts.push({ via: 'delivery', skipped: 'pdf-under-image-resource-type' });
  }

  if (!upstream && publicId) {
    // The signed URL carries the api key and its signature in the query string, so it is
    // the one URL in this file that must never reach a log line.
    const signed = uploadService.signedDownloadUrl({ publicId, format, resourceType });
    const result = await fetchUpstream(signed, 'download');
    attempts.push(result.attempt);
    upstream = result.response;
  } else if (!upstream) {
    attempts.push({ via: 'download', skipped: 'no-public-id' });
  }

  if (!upstream?.body) {
    // One line, at error level, carrying every attempt and why each failed — this is the
    // whole diagnosis, and it is the only place it exists now that the caller is told
    // something deliberately vague.
    const tried = attempts.filter((a) => a.status || a.error);
    const gone = tried.length > 0 && tried.every((a) => a.status === 404);
    logger.error(
      { ...context, attempts, outcome: gone ? 'asset-missing' : 'upstream-failed' },
      'Compliance document could not be retrieved from storage'
    );
    throw new ApiError(
      502,
      gone ? 'DOCUMENT_MISSING' : 'DOCUMENT_UNAVAILABLE',
      gone ? MESSAGES.gone : MESSAGES.unavailable
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
  // Forwarded only when the bytes we are about to write are the bytes upstream counted.
  // `fetch` transparently gunzips a compressed response, so a Content-Length measured on
  // the compressed body promises the client a size that never arrives — and a client left
  // waiting on the remainder of a short body is one more way this endpoint reads as a
  // gateway timeout rather than as an error.
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) res.setHeader('Content-Length', length);
  // Private: this is one restaurant's KYC paperwork, and it is fetched with credentials.
  res.setHeader('Cache-Control', 'private, max-age=300');

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    // Past the first byte there is no status code left to change, so the only honest
    // outcomes are a finished body or a destroyed socket: the caller then sees a truncated
    // transfer instead of waiting on a response that will never end. Swallowed rather than
    // rethrown because the error handler cannot answer a request already on the wire — and
    // an unhandled stream error here would otherwise take the whole process down, which
    // costs every other request in flight a 504 too.
    //
    // A client that closed the tab mid-download lands here as well, which is routine and
    // not worth an error-level line.
    const aborted = err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || res.req?.aborted;
    logger[aborted ? 'info' : 'error'](
      { ...context, err: err?.code ?? err?.name ?? String(err) },
      aborted
        ? 'Compliance document stream closed by the client'
        : 'Compliance document stream failed after headers were sent'
    );
    if (!res.writableEnded) res.destroy();
  }
};
