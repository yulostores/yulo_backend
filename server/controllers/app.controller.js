import { buildAppConfig, getLegalDocument } from '../config/appConfig.config.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// GET /api/app/config — everything the customer app's Settings screen renders: the
// languages it can switch to, the payment-method catalogue, the "About Yulo Stores"
// block, and the list of legal documents (titles + dates, not their text). Public and
// static — assembled fresh each call from config/appConfig.config.js, cheap enough that
// it needs no cache.
export const getAppConfig = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, 'App config', { config: buildAppConfig() });
});

// GET /api/app/legal/:docId — one legal document (`terms` | `privacy`) with its full
// section list. Kept separate from /config so the Settings list stays a small download
// and each document is fetched only when opened.
export const getLegalDoc = asyncHandler(async (req, res) => {
  const document = getLegalDocument(req.params.docId);
  if (!document) {
    throw new ApiError(404, 'NOT_FOUND', `Unknown legal document "${req.params.docId}"`);
  }
  sendSuccess(res, 200, 'Legal document', { document });
});
