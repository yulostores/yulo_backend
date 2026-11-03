import { MulterError } from 'multer';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// body-parser's own client errors: malformed JSON, a body over the size limit, an unsupported
// charset or encoding. They carry `expose: true` and a 4xx `status`; they were answered 500
// (and logged with a stack as if the server had failed — and a 500 to Razorpay's webhook makes
// it redeliver a body that can never parse).
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': { code: 'INVALID_JSON', message: 'The request body is not valid JSON' },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' },
};
const isClientHttpError = (err) =>
  Boolean(err?.expose) && Number.isInteger(err.status) && err.status >= 400 && err.status < 500;

// eslint-disable-next-line no-unused-vars
const SCOPE_KEYS = new Set(['restaurantId', 'ownerId', 'userId', '_id']);
const DUPLICATE_MESSAGES = {
  code: 'This coupon code is already in use',
  identifier: 'A table with this number already exists',
  name: 'Something with this name already exists',
  email: 'email already exists',
  phone: 'This phone number is already in use',
};

const humanField = (path) => {
  const last = String(path).split('.').pop();
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const readableValidation = (path, e) => {
  // A schema's own message ("Enter a valid 6-digit PIN code") is already written for people.
  if (e?.message && !/Path `/.test(e.message) && e.name !== 'CastError') return e.message;
  const label = humanField(path);
  const p = e?.properties ?? {};
  switch (e?.kind) {
    case 'required': return `${label} is required`;
    case 'maxlength': return `${label} must be at most ${p.maxlength} characters`;
    case 'minlength': return `${label} must be at least ${p.minlength} characters`;
    case 'max': return `${label} must be ${p.max} or less`;
    case 'min': return `${label} must be ${p.min} or more`;
    case 'enum': return `Choose a valid ${label.toLowerCase()}`;
    default: return e?.name === 'CastError' ? `${label} has an invalid value` : `${label} is invalid`;
  }
};

export const errorHandler = (err, req, res, next) => {
  // Expected, deliberate failures (a wrong OTP, an expired token, a validation miss) were
  // logged at error level with a full stack, which buried the ones that actually need
  // attention — an upstream provider failing, a 500 — in noise. Anything the app threw on
  // purpose is logged as a single structured warn line; everything else keeps the stack.
  if (!(err instanceof ApiError) && isClientHttpError(err)) {
    logger.warn({ status: err.status, type: err.type, url: req.url, method: req.method }, err.message);
    if (res.headersSent) return next(err);
    const known = BODY_PARSER_ERRORS[err.type];
    return res.status(err.status).json({
      status: 'error',
      code: known?.code ?? 'BAD_REQUEST',
      message: known?.message ?? err.message,
    });
  }

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
    // Mongoose's own text ("MenuItem validation failed: name: Path `name` (`…`, length 150) is
    // longer than…") reached the screen as-is. Say it the way a person would.
    const fieldErrors = Object.fromEntries(
      Object.entries(err.errors ?? {}).map(([path, e]) => [path, readableValidation(path, e)])
    );
    const first = Object.values(fieldErrors)[0];
    return res.status(400).json({
      status: 'error',
      code: 'VALIDATION_ERROR',
      message: first ?? err.message,
      ...(first && { details: { fieldErrors } }),
    });
  }

  if (err.code === 11000) {
    // Name the field the person typed. Most unique indexes are scoped per restaurant, and
    // naming the first key gave "restaurantId already exists" for a duplicate table number.
    const keys = Object.keys(err.keyPattern ?? {});
    const field = keys.find((k) => !SCOPE_KEYS.has(k)) ?? keys[0] ?? 'value';
    return res.status(409).json({
      status: 'error',
      code: 'DUPLICATE_KEY',
      field,
      message: DUPLICATE_MESSAGES[field] ?? `${field} already exists`,
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
