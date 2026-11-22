import { z } from 'zod';
import * as careers from '../services/jobApplication.service.js';
import { EDUCATION_LEVELS, GENDERS, JOB_DEPARTMENTS, MAX_SALARY_RUPEES } from '../config/careers.config.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { normalizeIndianPhone } from '../utils/phone.js';

// Public careers portal (yulo_careers). No accounts: the application's access token, handed out
// once by create, is sent back in the X-Application-Token header for everything after.

const parseOr400 = (schema, input, message = 'Please check the highlighted fields') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

// Multipart sends every field as a string, and an untouched optional field as "".
const blankToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker')
  .transform((s, ctx) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      ctx.addIssue({ code: 'custom', message: 'Not a real date' });
      return z.NEVER;
    }
    return d;
  });

const phone = (label) =>
  z.string().transform((v, ctx) => {
    const n = normalizeIndianPhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: `Enter a valid 10-digit ${label}` });
      return z.NEVER;
    }
    return n;
  });

const rupees = z.coerce.number({ message: 'Enter an amount' }).int('Whole rupees only').min(0).max(MAX_SALARY_RUPEES);

const applicationSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Enter your full name').max(100),
    phone: phone('mobile number'),
    alternatePhone: optional(phone('alternate mobile number')),
    dateOfBirth: calendarDate,
    gender: z.enum(GENDERS, { message: 'Select your gender' }),
    city: z.string().trim().min(2, 'Enter your city').max(80),
    department: z.enum(JOB_DEPARTMENTS.map((d) => d.key), { message: 'Select a position' }),
    role: z.string().trim().min(1, 'Select a role').max(60),
    expectedSalaryMin: rupees,
    expectedSalaryMax: rupees,
    currentSalary: optional(rupees),
    availableFrom: optional(calendarDate),
    education: optional(z.enum(EDUCATION_LEVELS.map((e) => e.key))),
    experienceYears: optional(z.coerce.number().min(0).max(50)),
    experience: optional(z.string().trim().max(1000)),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.expectedSalaryMax < v.expectedSalaryMin) {
      ctx.addIssue({ code: 'custom', path: ['expectedSalaryMax'], message: 'Maximum must be at least the minimum' });
    }
    if (v.alternatePhone && v.alternatePhone === v.phone) {
      ctx.addIssue({ code: 'custom', path: ['alternatePhone'], message: 'Use a different number from your mobile number' });
    }
  });

const verifySchema = z
  .object({
    razorpay_order_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().min(1).max(200),
  })
  .strict();

const tokenOf = (req) => req.get('x-application-token');

/** GET /api/careers/positions */
export const positions = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, 'Positions', careers.catalogue());
});

/** POST /api/careers/applications — multipart: the fields above + optional `resume` (PDF). */
export const createApplication = asyncHandler(async (req, res) => {
  const fields = parseOr400(applicationSchema, req.body);
  sendSuccess(res, 201, 'Application saved — pay the form fee to submit it', await careers.createApplication(fields, req.file));
});

/** GET /api/careers/applications/:id */
export const getApplication = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Application', { application: await careers.getOwned(req.params.id, tokenOf(req)) });
});

/** POST /api/careers/applications/:id/pay */
export const pay = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Payment started', await careers.retryPayment(req.params.id, tokenOf(req)));
});

/** POST /api/careers/applications/:id/verify */
export const verify = asyncHandler(async (req, res) => {
  const body = parseOr400(verifySchema, req.body, 'Invalid payment confirmation');
  sendSuccess(res, 200, 'Application submitted', { application: await careers.verifyPayment(req.params.id, tokenOf(req), body) });
});

/** POST /api/careers/applications/:id/simulate-payment — local development only. */
export const simulatePayment = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Application submitted (simulated payment)', {
    application: await careers.simulatePayment(req.params.id, tokenOf(req)),
  });
});
