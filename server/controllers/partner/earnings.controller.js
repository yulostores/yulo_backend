import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getCashInHand } from '../../services/cashLedger.service.js';
import { getEarningsForPeriod } from '../../services/earnings.service.js';
import { partnerPayoutHistory } from '../../services/payout.service.js';

export const getCashInHandHandler = asyncHandler(async (req, res) => {
  const cashInHand = await getCashInHand(req.partner._id);
  sendSuccess(res, 200, 'Cash in hand', { cashInHand });
});

const VALID_PERIODS = ['today', 'weekly', 'monthly'];

export const getEarningsHandler = asyncHandler(async (req, res) => {
  const { period = 'today' } = req.query;
  if (!VALID_PERIODS.includes(period)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'period must be one of today, weekly, monthly');
  }

  const data = await getEarningsForPeriod(req.partner._id, period);
  sendSuccess(res, 200, 'Earnings', data);
});

// GET /api/partner/earnings/payouts — the rider's weekly payouts, newest first: what each week
// came to, and whether Yulo has paid it (with the date and the bank / UPI reference).
export const getPayoutsHandler = asyncHandler(async (req, res) => {
  const payouts = await partnerPayoutHistory(req.partner._id, { limit: 12 });
  sendSuccess(res, 200, 'Payouts', { payouts });
});
