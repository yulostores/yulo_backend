import { ApiError } from '../../utils/ApiError.js';
import { manualProvider } from './manual.provider.js';
import { bankFileProvider } from './bankFile.provider.js';

// How an approved restaurant settlement is paid. Every provider has the same four functions,
// so settlements, approvals and the admin screens never need to know which one is in use:
//
//   ensureBeneficiary(restaurant)   is this restaurant ready to be paid this way?
//                                   → { ready: true } or { ready: false, reason }
//   createPayout(settlement, ctx)   start paying it (bank_file: put it on a batch's payment
//                                   line; a gateway provider: call its payout API)
//   getPayoutStatus(settlement)     where the payout stands
//   handleWebhook(event)            a provider's server-to-server update (none for bank files —
//                                   the bank's results come back through reconciliation)
//
// Available today: 'manual' (paid by any means, marked paid with a UTR) and 'bank_file'
// (weekly net-banking bulk upload). RazorpayX / Route slot in here once one is activated.

const PROVIDERS = { manual: manualProvider, bank_file: bankFileProvider };

export const getPayoutProvider = (name) => {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new ApiError(501, 'PAYOUT_PROVIDER_UNAVAILABLE', `Payout provider "${name}" is not available yet`);
  }
  return provider;
};

export { verifiedBeneficiary } from './beneficiary.js';
