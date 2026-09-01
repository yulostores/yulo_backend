import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Rejecting with an error rather than `cb(null, false)` is the whole point: a silent
// `false` drops the file and lets the controller answer 200 as if nothing was uploaded,
// which is indistinguishable from success on the client.
const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG and WebP are allowed'));
  }
};

export const upload = (fieldName, maxSizeMB) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter,
  }).single(fieldName);

// Several optional files in one request (store settings sends `logo` and `banner`
// together). `maxSizeMB` is a single ceiling across all fields — multer has no per-field
// limit — so pass the largest any of them may be.
export const uploadFields = (fieldNames, maxSizeMB) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMB * 1024 * 1024 },
    fileFilter,
  }).fields(fieldNames.map((name) => ({ name, maxCount: 1 })));
