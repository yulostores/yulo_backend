import { z } from 'zod';
import * as redemption from '../../services/couponRedeem.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — redeeming a customer's coupon at the counter (services/couponRedeem.service.js).
// Every role (owner, manager, employee); approved sellers only (routes/seller/index.js).

// Loose on purpose: people type codes with spaces and dashes, and scanners add whitespace. The
// service normalises; anything that can't be a code answers 404 like an unknown one.
const codeField = z.string().trim().min(1, 'Enter the coupon code').max(40);
const lookupSchema = z.object({ code: codeField });
const redeemSchema = z.object({
  code: codeField,
  phoneLast4: z.string().trim().regex(/^\d{4}$/, 'Enter the last 4 digits of the phone number').optional(),
});

const parseOr400 = (schema, input) => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? 'Invalid request', flat);
  }
  return parsed.data;
};

const who = (req) => ({ sellerId: req.seller.sellerId, userId: req.seller.userId });

/** POST /api/seller/redeem/lookup  { code } */
export const lookup = asyncHandler(async (req, res) => {
  const { code } = parseOr400(lookupSchema, req.body);
  sendSuccess(res, 200, 'Coupon', { coupon: await redemption.lookup({ ...who(req), code }) });
});

/** POST /api/seller/redeem  { code, phoneLast4? } */
export const redeem = asyncHandler(async (req, res) => {
  const { code, phoneLast4 } = parseOr400(redeemSchema, req.body);
  sendSuccess(res, 200, 'Coupon redeemed', { coupon: await redemption.redeem({ ...who(req), code, phoneLast4 }) });
});

/** GET /api/seller/redeem/today */
export const today = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, "Today's redemptions", await redemption.today({ ...who(req), role: req.seller.role }));
});
