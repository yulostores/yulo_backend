import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as settlementService from '../../services/settlement.service.js';
import { ownerViewOfEntry } from '../../services/ledger.service.js';
import { ENTRY_EXPORT_COLUMNS, localDay, toCsv } from '../../config/settlementExport.config.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';

// The restaurant's own weekly settlements — what it was paid, and how that was reached, row by
// row. Razorpay's fee, Yulo's margin and rider pay are never included (ownerViewOfEntry, and
// the CSV drops its adminOnly columns); nor are admin/payout internals (ownerViewOfSettlement).

const listSchema = z.object({
  status: z.enum(['draft', 'approved', 'processing', 'paid', 'failed', 'on_hold', 'carried_forward']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// A settlement of THIS restaurant — another restaurant's id answers 404, never its data.
const ownSettlementDetail = async (req) => {
  const detail = await settlementService.getSettlementDetail(req.params.settlementId);
  if (String(detail.settlement.restaurantId) !== String(req.restaurant._id)) {
    throw new ApiError(404, 'NOT_FOUND', 'Settlement not found');
  }
  return detail;
};

// GET /api/owner/:restaurantId/settlements
export const list = asyncHandler(async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const result = await settlementService.listSettlements({ ...parsed.data, restaurantId: req.restaurant._id });
  const { timezone } = (await getActiveSettings()).settlementCycle;
  sendSuccess(res, 200, 'Settlements', {
    ...result,
    settlements: result.settlements.map((s) => settlementService.ownerViewOfSettlement(s, { timezone })),
  });
});

// GET /api/owner/:restaurantId/settlements/:settlementId
export const detail = asyncHandler(async (req, res) => {
  const { settlement, entries } = await ownSettlementDetail(req);
  const { timezone } = (await getActiveSettings()).settlementCycle;
  sendSuccess(res, 200, 'Settlement', {
    // The admin's hold note is staff-only — ownerViewOfSettlement never includes it.
    settlement: settlementService.ownerViewOfSettlement(settlement, { timezone }),
    entries: entries.map(ownerViewOfEntry),
  });
});

// GET /api/owner/:restaurantId/settlements/:settlementId/export — CSV of the statement.
export const exportOne = asyncHandler(async (req, res) => {
  const { settlement, entries } = await ownSettlementDetail(req);
  const { timezone } = (await getActiveSettings()).settlementCycle;
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="settlement-${localDay(settlement.periodStart, timezone)}.csv"`);
  res.send(toCsv(ENTRY_EXPORT_COLUMNS, entries, { audience: 'owner', timezone }));
});

