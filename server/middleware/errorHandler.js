import { MulterError } from 'multer';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  // Expected, deliberate failures (a wrong OTP, an expired token, a validation miss) were
  // logged at error level with a full stack, which buried the ones that actually need
  // attention — an upstream provider failing, a 500 — in noise. Anything the app threw on
  // purpose is logged as a single structured warn line; everything else keeps the stack.
  if (err instanceof ApiError) {
    const context = {
      code: err.code,
      status: err.statusCode,
      url: req.url,
      method: req.method,
      ...(err.details && { details: err.details }),
    };
    // A deliberate 5xx is still a real incident (a third-party outage, say) — those keep
    // error level so they stay visible in the platform's log filters.
    if (err.statusCode >= 500) logger.error({ ...context, err }, err.message);
    else logger.warn(context, err.message);
  } else {
    logger.error({ err, url: req.url, method: req.method });
  }

  // A streaming route (the document endpoints) can fail after its headers and part of its
  // body are already on the wire. There is no status code left to send at that point:
  // writing one throws ERR_HTTP_HEADERS_SENT, which is unhandled here and would take the
  // process down. Hand it to Express's own final handler, which closes the connection so
  // the client sees a truncated transfer rather than a response that never ends.
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      status: 'error',
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  // Multer rejects a file before any controller runs — an over-limit or unexpected upload
  // is the caller's mistake, so it must not fall through to a 500. `field` tells a
  // multi-file form (logo vs banner, partner documents) which input was at fault.
  if (err instanceof MulterError) {
    return res.status(400).json({
      status: 'error',
      code: err.code,
      message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message,
      ...(err.field && { details: { field: err.field } }),
    });
  }

  // A value that can't be coerced into its schema type ("nineteen" for a Number field) is
  // malformed input, not a server fault — 500 would both mislead the caller and bury a
  // fixable typo. `path` names the offending field.
  if (err.name === 'CastError') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: `${err.path} has an invalid value`,
      details: { field: err.path },
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: err.message,
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(409).json({
      status: 'error',
      code: 'DUPLICATE_KEY',
      message: `${field} already exists`,
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      status: 'error',
      code: 'INVALID_TOKEN',
      message: err.message,
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      status: 'error',
      code: 'TOKEN_EXPIRED',
      message: 'Token has expired',
    });
  }

  return res.status(500).json({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
};
