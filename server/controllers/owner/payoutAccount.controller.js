import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as payoutAccountService from '../../services/payoutAccount.service.js';

// GET /api/owner/:restaurantId/payout-account — the bank account settlements are paid into,
// masked (last four digits only), with its verification status and the proof document's.
export const getPayoutAccount = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Bank account', { account: await payoutAccountService.getPayoutAccount(req.restaurant._id) });
});

// PUT /api/owner/:restaurantId/payout-account — add or change it. Body: { accountHolderName,
// accountNumber, confirmAccountNumber, ifsc, bankName?, branch?, accountType }. Upload a
// cancelled cheque or bank statement as the 'bank_statement' document (POST …/documents) as
// proof. Before the account is verified a change replaces it (pending verification again);
// once verified, a change is a REQUEST — `account.pendingChange` — and payouts keep going to
// the verified account until Yulo verifies the new one. Saving the verified details again
// withdraws an open request.
export const savePayoutAccount = asyncHandler(async (req, res) => {
  const { account, changed, changeRequested } = await payoutAccountService.savePayoutAccount(req.restaurant._id, req.body);
  let message = 'No changes';
  if (changed && changeRequested) message = 'Change requested — your verified account stays in use until Yulo verifies the new one';
  else if (changed && account.status === 'verified') message = 'Change request withdrawn';
  else if (changed) message = 'Bank account saved — pending verification';
  sendSuccess(res, 200, message, { account, changed, changeRequested });
});
