import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';
import { listLedger, ownerViewOfEntry } from '../../services/ledger.service.js';
import { weekBounds } from '../../utils/week.js';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z
    .enum(['order_earning', 'dine_in_earning', 'counter_platform_fee', 'refund_gateway_fee', 'adjustment', 'carry_forward'])
    .optional(),
  // Any moment inside the settlement week wanted (e.g. 2026-10-14) — the week is drawn in the
  // platform's settlement time zone, the same boundaries the weekly settlement uses.
  week: z.coerce.date().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// GET /api/owner/:restaurantId/ledger — the restaurant's account with Yulo: one row per
// credit (orders paid online, bills paid online) or debit (platform fee on counter-paid bills,
// refund fees, adjustments), newest first, with credit/debit totals for the same filter.
// Amounts in PAISE. Razorpay's fee, Yulo's margin and the rider's pay are not the restaurant's
// business and are stripped from every row's breakdown.
export const getLedger = asyncHandler(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  }
  const { page, limit, type, week } = parsed.data;
  let { from, to } = parsed.data;
  if (week) {
    ({ start: from, end: to } = weekBounds(week, (await getActiveSettings()).settlementCycle));
  }

  const result = await listLedger({ restaurantId: req.restaurant._id, type, from, to, page, limit });
  sendSuccess(res, 200, 'Ledger', {
    ...result,
    entries: result.entries.map(ownerViewOfEntry),
    range: from || to ? { from: from ?? null, to: to ?? null } : null,
  });
});
