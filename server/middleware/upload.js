import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

// Exported so the same list can be described to clients (config/storeSettings.config.js
// serves it to the owner portal), rather than each of them keeping its own copy of what
// this filter will accept.
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Rejecting with an error rather than `cb(null, false)` is the whole point: a silent
// `false` drops the file and lets the controller answer 200 as if nothing was uploaded,
// which is indistinguishable from success on the client.
const fileFilter = (_req, file, cb) => {
  if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new ApiError(400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG and WebP are allowed'));
  }
};

// The declared type is only what the browser guessed from the file name: a text file
// renamed .png passed the filter above and failed later at Cloudinary as a 500 "upload
// failed". The first bytes say what the file really is.
const looksLikeImage = (buf) => {
  if (!buf || buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
};

const checkContents = (middleware) => (req, res, next) =>
  middleware(req, res, (err) => {
    if (err) return next(err);
    const files = [req.file, ...Object.values(req.files ?? {}).flat()].filter(Boolean);
    if (files.some((f) => !looksLikeImage(f.buffer))) {
      return next(new ApiError(400, 'INVALID_FILE_TYPE', "That file isn't a JPEG, PNG or WebP image"));
    }
    return next();
  });

export const upload = (fieldName, maxSizeMB) =>
  checkContents(
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxSizeMB * 1024 * 1024 },
      fileFilter,
    }).single(fieldName)
  );

// Several optional files in one request (store settings sends `logo` and `banner`
// together). `maxSizeMB` is a single ceiling across all fields — multer has no per-field
// limit — so pass the largest any of them may be.
export const uploadFields = (fieldNames, maxSizeMB) =>
  checkContents(
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxSizeMB * 1024 * 1024 },
      fileFilter,
    }).fields(fieldNames.map((name) => ({ name, maxCount: 1 })))
  );
