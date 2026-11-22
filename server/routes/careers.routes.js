import { Router } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import * as careers from '../controllers/careers.controller.js';
import { RESUME_MAX_MB } from '../config/careers.config.js';
import { ApiError } from '../utils/ApiError.js';

// Public careers portal (yulo_careers) — see controllers/careers.controller.js.

const router = Router();

// Creating an application uploads a file and opens a Razorpay order — the costliest public
// call there is, so it gets its own budget per IP. Refused attempts (a validation error) don't
// count, so someone fixing their form isn't locked out; a college or office sharing one IP can
// still send twenty in ten minutes.
export const applyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  skipFailedRequests: true,
  keyGenerator: (req) => `careers-apply:${ipKeyGenerator(req.ip ?? '')}`,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many applications from this network. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

/** The apply limiter's key for an IP (tests reset it with applyLimiter.resetKey). */
export const applyLimiterKey = (ip) => `careers-apply:${ipKeyGenerator(ip ?? '')}`;

const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RESUME_MAX_MB * 1024 * 1024, files: 1, fields: 30 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new ApiError(400, 'INVALID_FILE_TYPE', 'The resume must be a PDF file'));
  },
}).single('resume');

router.get('/positions', careers.positions);
router.post('/applications', applyLimiter, resumeUpload, careers.createApplication);
router.get('/applications/:id', careers.getApplication);
router.post('/applications/:id/pay', applyLimiter, careers.pay);
router.post('/applications/:id/verify', careers.verify);
router.post('/applications/:id/simulate-payment', careers.simulatePayment);

export default router;
