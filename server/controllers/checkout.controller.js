import { z } from 'zod';
import * as checkoutService from '../services/checkout.service.js';
import * as activityService from '../services/activity.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Both optional: addressId prices against the address the customer picked (default address
// otherwise), tip (rupees) is included in the total.
const summaryQuerySchema = z.object({
  addressId: z.string().regex(/^[a-f\d]{24}$/i, 'must be an address id').optional(),
  tip: z.coerce.number().min(0).optional(),
});

export const getSummary = asyncHandler(async (req, res) => {
  const parsed = summaryQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', parsed.error.flatten());
  }
  const summary = await checkoutService.getCheckoutSummary(req.user._id, parsed.data);
  sendSuccess(res, 200, 'Checkout summary', summary);
  // An empty cart has no restaurant, so nothing is recorded for it.
  void activityService.record(req, summary.cart?.restaurantId, 'checkout_started', {
    totalPaise: summary.bill?.charges?.grandTotal,
    cart: summary.cart,
    bill: summary.bill,
  });
});
