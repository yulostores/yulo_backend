import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { isCodEnabled } from '../../config/payments.config.js';

// GET /api/partner/config — runtime switches the rider app reads on start: codEnabled hides the
// cash-collection screens while cash on delivery is paused (Finance Settings → codEnabled).
export const getPartnerConfig = asyncHandler(async (_req, res) => {
  sendSuccess(res, 200, 'Partner app config', { config: { codEnabled: await isCodEnabled() } });
});
