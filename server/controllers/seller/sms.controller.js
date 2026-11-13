import { z } from 'zod';
import * as credits from '../../services/smsCredits.service.js';
import { sellerRemindersView } from '../../services/couponReminders.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — reminder-SMS credits and reminders (services/smsCredits.service.js,
// services/couponReminders.service.js). Owner and manager; approved sellers only.

const parseOr400 = (schema, input, message) => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? message, flat);
  }
  return parsed.data;
};

const purchaseSchema = z.object({ credits: z.number().int().positive() }).strict();
const verifySchema = z
  .object({
    razorpay_order_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().min(1).max(200),
  })
  .strict();

/** GET /api/seller/sms-credits */
export const getCredits = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'SMS credits', await credits.creditsView(req.seller.sellerId));
});

/** POST /api/seller/sms-credits/purchase { credits } */
export const purchase = asyncHandler(async (req, res) => {
  const body = parseOr400(purchaseSchema, req.body, 'Choose a pack');
  sendSuccess(res, 201, 'Purchase started', await credits.startPurchase(req.seller.sellerId, body.credits));
});

/** POST /api/seller/sms-credits/purchase/:id/verify */
export const verify = asyncHandler(async (req, res) => {
  const body = parseOr400(verifySchema, req.body, 'Invalid payment confirmation');
  sendSuccess(res, 200, 'Credits added', { purchase: await credits.verifyPurchase(req.seller.sellerId, req.params.id, body) });
});

/** POST /api/seller/sms-credits/purchase/:id/simulate-payment — local development only. */
export const simulate = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Credits added', { purchase: await credits.simulatePurchase(req.seller.sellerId, req.params.id) });
});

/** GET /api/seller/reminders */
export const reminders = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Reminders', await sellerRemindersView(req.seller.sellerId));
});
