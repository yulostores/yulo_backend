import { z } from 'zod';
import mongoose from 'mongoose';
import * as reminders from '../../services/couponReminders.service.js';
import * as credits from '../../services/smsCredits.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { receivedOnSchema } from '../../utils/receivedOn.js';

// Super admin — reminder campaigns and "Amount Received" for SMS credits (§ CB10).

const parseOr400 = (schema, input, message) => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? message, flat);
  }
  return parsed.data;
};

/** POST /api/admin/reminder-campaigns/preview { category?, seller?, expiringFrom?, expiringTo? } */
export const preview = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Campaign preview', await reminders.previewCampaign(req.body));
});

/** POST /api/admin/reminder-campaigns — queued for the next 10:00 IST run. */
export const create = asyncHandler(async (req, res) => {
  sendSuccess(res, 201, 'Campaign queued', { campaign: await reminders.createCampaign(req.user._id, req.body) });
});

const listQuery = z.object({
  type: z.enum(['admin', 'seller']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/admin/reminder-campaigns?type=admin|seller */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Campaigns', await reminders.listCampaigns(parseOr400(listQuery, req.query, 'Invalid filters')));
});

/** GET /api/admin/reminder-campaigns/:id */
export const detail = asyncHandler(async (req, res) => {
  const { page, limit } = parseOr400(listQuery.pick({ page: true, limit: true }), req.query, 'Invalid paging');
  sendSuccess(res, 200, 'Campaign', await reminders.campaignDetail(req.params.id, { page, limit }));
});

const manualCreditsSchema = z
  .object({
    credits: z.number().int().positive().max(1_000_000),
    amountRupees: z.number().positive().max(10_000_000),
    mode: z.enum(['neft', 'upi', 'cash', 'cheque', 'other']),
    reference: z.string().trim().min(3, 'Enter the payment reference').max(100),
    receivedOn: receivedOnSchema,
    note: z.string().trim().max(500).optional(),
    overrideReason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

/** POST /api/admin/sellers/:id/sms-credits/manual — "Amount Received" for SMS credits. */
export const recordManualCredits = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  const body = parseOr400(manualCreditsSchema, req.body, 'Invalid payment details');
  sendSuccess(res, 201, 'Payment recorded — credits added', await credits.recordManualPayment(req.params.id, req.user._id, body));
});
