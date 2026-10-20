// Weekly net-banking bulk upload. The real work is in services/payoutBatch.service.js (batches,
// the file, reconciliation); this is the provider-shaped face of it.
import { verifiedBeneficiary } from './beneficiary.js';

export const bankFileProvider = {
  name: 'bank_file',
  ensureBeneficiary: async (restaurant) => {
    const result = await verifiedBeneficiary(restaurant._id ?? restaurant);
    return result.ready ? { ready: true } : result;
  },
  // Payment happens when the admin uploads the batch file; a settlement is "initiated" once it
  // is on a batch (payoutBatch.service.js's createBatch).
  createPayout: async (settlement) => ({
    initiated: settlement.status === 'processing',
    reference: settlement.payout?.reference ?? null,
    batchId: settlement.payout?.batchId ?? null,
  }),
  getPayoutStatus: async (settlement) => ({
    status: settlement.status,
    reference: settlement.payout?.reference ?? null,
    utr: settlement.payout?.utr ?? null,
    failureReason: settlement.payout?.failureReason ?? null,
  }),
  // Banks don't call back; their result file is reconciled by an admin.
  handleWebhook: async () => null,
};
