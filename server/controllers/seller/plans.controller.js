import { z } from 'zod';
import * as subscriptions from '../../services/sellerSubscription.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — plans and purchases (services/sellerSubscription.service.js). Reads: owner and
// manager. Buying: owner only. Employees never reach these (routes/seller/index.js).

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const parseOr400 = (schema, input, message = 'Invalid request') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

/** GET /api/seller/plans */
export const listPlans = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Plans', { plans: await subscriptions.listActivePlans() });
});

/** GET /api/seller/subscriptions */
export const listSubscriptions = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Subscriptions', await subscriptions.sellerSubscriptions(req.seller.sellerId));
});

/** POST /api/seller/subscriptions  { planKey } */
export const buyPlan = asyncHandler(async (req, res) => {
  const { planKey } = parseOr400(z.object({ planKey: z.string().trim().min(1).max(40) }).strict(), req.body, 'Choose a plan');
  sendSuccess(res, 201, 'Plan purchase started', await subscriptions.startPurchase(req.seller.sellerId, planKey.toLowerCase()));
});

const verifySchema = z
  .object({
    razorpay_order_id: z.string().min(1).max(100),
    razorpay_payment_id: z.string().min(1).max(100),
    razorpay_signature: z.string().min(1).max(200),
  })
  .strict();

/** POST /api/seller/subscriptions/:id/verify */
export const verifyPlanPayment = asyncHandler(async (req, res) => {
  parseOr400(objectId, req.params.id, 'Invalid subscription');
  const body = parseOr400(verifySchema, req.body, 'Invalid payment confirmation');
  sendSuccess(res, 200, 'Plan activated', {
    subscription: await subscriptions.verifyPurchase(req.seller.sellerId, req.params.id, body),
  });
});

/** POST /api/seller/subscriptions/:id/simulate-payment — local development only. */
export const simulatePlanPayment = asyncHandler(async (req, res) => {
  parseOr400(objectId, req.params.id, 'Invalid subscription');
  sendSuccess(res, 200, 'Plan activated (simulated payment)', {
    subscription: await subscriptions.simulatePurchase(req.seller.sellerId, req.params.id),
  });
});
