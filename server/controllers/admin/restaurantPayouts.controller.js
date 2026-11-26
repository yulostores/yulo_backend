import { z } from 'zod';
import mongoose from 'mongoose';

import * as payouts from '../../services/restaurantPayouts.service.js';
import { PAYMENT_MODES } from '../../models/RestaurantPayment.js';
import { payoutMode } from '../../config/payoutMode.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// The super admin paying restaurants any day, in full or in part, and the daily / range report
// (services/restaurantPayouts.service.js). Mounted at /api/admin/finance/restaurant-payouts.

const objectId = z.string().refine(mongoose.isValidObjectId, 'Invalid id');
const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', r.error.issues[0]?.message ?? 'Invalid request', r.error.flatten());
  return r.data;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** GET …/balances?q&due=1&page&limit */
export const balances = asyncHandler(async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional(), due: z.enum(['0', '1']).optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
  sendSuccess(res, 200, 'Restaurant balances', { mode: payoutMode(), ...(await payouts.listBalances({ ...q, due: q.due === '1' })) });
});

/** GET …/balances/:restaurantId */
export const balance = asyncHandler(async (req, res) => {
  const { restaurantId } = parse(z.object({ restaurantId: objectId }), req.params);
  sendSuccess(res, 200, 'Restaurant balance', await payouts.restaurantBalance(restaurantId));
});

/** POST …/balances/:restaurantId/pay — { full | amountPaise, mode, reference, paidOn?, note?, expectedBalancePaise } */
export const pay = asyncHandler(async (req, res) => {
  const { restaurantId } = parse(z.object({ restaurantId: objectId }), req.params);
  const body = parse(
    z
      .object({
        full: z.boolean().optional(),
        amountPaise: z.number().int().positive().optional(),
        mode: z.enum(PAYMENT_MODES, { errorMap: () => ({ message: 'Choose how the money was sent' }) }),
        reference: z.string().trim().min(3, 'Enter the UTR / payment reference').max(60),
        paidOn: day.optional(),
        note: z.string().max(300).optional(),
        expectedBalancePaise: z.number().int(),
      })
      .refine((b) => b.full || b.amountPaise, 'Enter an amount, or pay the full balance'),
    req.body
  );
  sendSuccess(res, 201, 'Payment recorded', await payouts.payRestaurant(restaurantId, body, req.user._id));
});

const listQuery = z.object({
  restaurantId: objectId.optional(),
  from: day.optional(),
  to: day.optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET …/payments?restaurantId&from&to&page&limit */
export const payments = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Restaurant payments', await payouts.listPayments(parse(listQuery, req.query)));
});

const reportQuery = z.object({ restaurantId: objectId.optional(), from: day.optional(), to: day.optional() });

/** GET …/daily?restaurantId&from&to */
export const daily = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Daily payout report', await payouts.dailyReport(parse(reportQuery, req.query)));
});

/** GET …/daily/export.xlsx?restaurantId&from&to */
export const dailyExport = asyncHandler(async (req, res) => {
  const { buffer, filename } = await payouts.dailyReportWorkbook(parse(reportQuery, req.query));
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});
