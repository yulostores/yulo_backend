// Paid outside the system (net banking by hand, cheque…) and recorded with its UTR through
// PATCH /api/admin/finance/settlements/:id/mark-paid. Nothing to send, nothing to receive.
import { verifiedBeneficiary } from './beneficiary.js';

export const manualProvider = {
  name: 'manual',
  ensureBeneficiary: async (restaurant) => {
    const result = await verifiedBeneficiary(restaurant._id ?? restaurant);
    return result.ready ? { ready: true } : result;
  },
  createPayout: async () => ({ initiated: false, instructions: 'Pay the restaurant, then mark the settlement paid with the UTR.' }),
  getPayoutStatus: async (settlement) => ({ status: settlement.status, utr: settlement.payout?.utr ?? null }),
  handleWebhook: async () => null,
};
