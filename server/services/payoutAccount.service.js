import { z } from 'zod';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import { ApiError } from '../utils/ApiError.js';
import { encryptField, decryptField } from '../utils/fieldEncryption.js';
import { logActivity } from './activityLog.service.js';

// The bank account a restaurant's weekly settlement is paid into (Restaurant.payoutAccount).
// The owner enters it; an admin verifies it against the uploaded proof (the existing
// 'bank_statement' compliance document) before any payout may go to it (B8 holds settlements
// for an unverified account).
//
// Changing it (B12, the design's "Bank requests"):
//   - no account yet, or one not yet verified (pending / rejected) → the new details replace it
//     and go to pending_verification, as before;
//   - a VERIFIED account → a change REQUEST (payoutAccount.pendingChange). The verified account
//     stays in force — scheduled and failed payouts keep going to it — until an admin verifies
//     the request, which then replaces it. The admin can also reject it or ask the owner for
//     information. "A request does not change any payout status."

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER = /^[0-9]{9,18}$/;
// What banks accept as a beneficiary name in a bulk-payment file: letters, digits, spaces and
// a little punctuation, starting with a letter or digit. Anything else (=, +, @, quotes…) could
// break the bank's parser or be read as a formula when the file is opened in a spreadsheet.
const HOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 .,&'()\/-]*$/;
const SECRET_PATH = '+payoutAccount.accountNumberEncrypted';
const PENDING_SECRET_PATH = '+payoutAccount.pendingChange.accountNumberEncrypted';
// Open = still needs an admin's decision.
export const OPEN_REQUEST_STATUSES = ['in_review', 'awaiting_restaurant'];
const PENDING_FIELDS = ['accountHolderName', 'accountNumberLast4', 'ifsc', 'bankName', 'branch', 'accountType'];

export const ownerPayoutAccountSchema = z
  .object({
    accountHolderName: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(HOLDER_NAME, 'Use letters, numbers, spaces and . , & \' ( ) / - only, as printed on the cheque'),
    accountNumber: z.string().trim().regex(ACCOUNT_NUMBER, 'Account number must be 9 to 18 digits'),
    confirmAccountNumber: z.string().trim(),
    ifsc: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.string().regex(IFSC, 'Enter a valid 11-character IFSC, e.g. HDFC0001234')),
    bankName: z.string().trim().max(120).optional().nullable(),
    branch: z.string().trim().max(120).optional().nullable(),
    accountType: z.enum(['savings', 'current']),
  })
  .strict()
  .refine((v) => v.accountNumber === v.confirmAccountNumber, {
    message: 'Account numbers do not match',
    path: ['confirmAccountNumber'],
  });

const maskedNumber = (last4) => (last4 ? `XXXXXX${last4}` : null);

/**
 * The account as any client may see it: never the number itself, only its last four digits.
 * Includes the status of the proof document (bank_statement) the admin checks it against.
 */
const proofView = (restaurant, id = null) => {
  const docs = (restaurant?.documents ?? []).filter((d) => d.type === 'bank_statement' || (id && d.type === 'bank_statement_change'));
  const proof = (id ? docs.find((d) => String(d._id) === String(id)) : null) ?? docs[0] ?? null;
  return proof ? { _id: proof._id, status: proof.status, uploadedAt: proof.uploadedAt } : null;
};

/** A change request as any client may see it — masked like the account itself. */
const pendingChangeView = (restaurant) => {
  const pc = restaurant?.payoutAccount?.pendingChange;
  if (!pc?.status) return null;
  return {
    status: pc.status,
    accountHolderName: pc.accountHolderName ?? null,
    accountNumberLast4: pc.accountNumberLast4 ?? null,
    accountNumberMasked: maskedNumber(pc.accountNumberLast4),
    ifsc: pc.ifsc ?? null,
    bankName: pc.bankName ?? null,
    branch: pc.branch ?? null,
    accountType: pc.accountType ?? null,
    requestedAt: pc.requestedAt ?? null,
    // The admin's question — the message and when, never which admin asked.
    infoRequest: pc.infoRequest?.message ? { message: pc.infoRequest.message, at: pc.infoRequest.at } : null,
    rejectionReason: pc.rejectionReason ?? null,
    proofDocument: proofView(restaurant, pc.proofDocumentId),
  };
};

/** True while a change request waits for an admin — releases still go to the verified account. */
export const hasPendingChange = (restaurant) =>
  OPEN_REQUEST_STATUSES.includes(restaurant?.payoutAccount?.pendingChange?.status);

export const payoutAccountView = (restaurant) => {
  const pa = restaurant?.payoutAccount ?? {};
  return {
    status: pa.status ?? 'not_added',
    accountHolderName: pa.accountHolderName ?? null,
    accountNumberLast4: pa.accountNumberLast4 ?? null,
    accountNumberMasked: maskedNumber(pa.accountNumberLast4),
    ifsc: pa.ifsc ?? null,
    bankName: pa.bankName ?? null,
    branch: pa.branch ?? null,
    accountType: pa.accountType ?? null,
    rejectionReason: pa.rejectionReason ?? null,
    submittedAt: pa.submittedAt ?? null,
    verifiedAt: pa.verifiedAt ?? null,
    proofDocument: proofView(restaurant),
    pendingChange: pendingChangeView(restaurant),
    hasPendingChange: hasPendingChange(restaurant),
  };
};

const loadWithSecret = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select(`${SECRET_PATH} ${PENDING_SECRET_PATH}`);
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  return restaurant;
};

export const getPayoutAccount = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select('payoutAccount documents').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  return payoutAccountView(restaurant);
};

const sameDetails = (stored, data) =>
  Boolean(stored?.accountNumberEncrypted) &&
  decryptField(stored.accountNumberEncrypted) === data.accountNumber &&
  stored.accountHolderName === data.accountHolderName &&
  stored.ifsc === data.ifsc &&
  (stored.bankName ?? null) === (data.bankName ?? null) &&
  (stored.branch ?? null) === (data.branch ?? null) &&
  stored.accountType === data.accountType;

const latestProofId = (restaurant) =>
  (restaurant.documents ?? []).filter((d) => d.type === 'bank_statement').sort((a, b) => new Date(b.uploadedAt ?? 0) - new Date(a.uploadedAt ?? 0))[0]?._id ?? null;

// A change request's proof: the owner's upload for the new account when there is one, else
// the verified account's proof (the admin may then ask for a new one).
const changeProofId = (restaurant) =>
  (restaurant.documents ?? []).find((d) => d.type === 'bank_statement_change')?._id ?? latestProofId(restaurant);

/**
 * Owner adds or changes the account. Saving exactly what is already on file changes nothing.
 * Before an account is verified, a change replaces it (back to pending_verification, and the
 * payout provider's beneficiary ids — which belong to the old account — are dropped). Once one
 * is verified, a change becomes a change request and the verified account stays in force:
 *   - the same details as the open request → nothing (unless the admin asked for information:
 *     resubmitting answers it, back to in_review);
 *   - the same details as the verified account → the open request is withdrawn;
 *   - anything else → a new request (in_review), replacing any earlier one.
 * Returns { account, changed, changeRequested }.
 */
export const savePayoutAccount = async (restaurantId, input) => {
  const parsed = ownerPayoutAccountSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid bank account details', parsed.error.flatten());
  }
  const data = parsed.data;
  const restaurant = await Restaurant.findById(restaurantId).select(`${SECRET_PATH} ${PENDING_SECRET_PATH}`);
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const current = restaurant.payoutAccount ?? {};
  const pending = current.pendingChange ?? {};
  const view = () => payoutAccountView(restaurant.toObject());

  if (current.status === 'verified') {
    if (sameDetails(current, data)) {
      if (!OPEN_REQUEST_STATUSES.includes(pending.status)) return { account: view(), changed: false, changeRequested: false };
      // Withdrawing the request: the owner went back to the account already verified.
      restaurant.set('payoutAccount.pendingChange', undefined);
      await restaurant.save();
      return { account: view(), changed: true, changeRequested: false };
    }
    if (OPEN_REQUEST_STATUSES.includes(pending.status) && sameDetails(pending, data)) {
      if (pending.status !== 'awaiting_restaurant') return { account: view(), changed: false, changeRequested: true };
      restaurant.set('payoutAccount.pendingChange.status', 'in_review');
      restaurant.set('payoutAccount.pendingChange.proofDocumentId', changeProofId(restaurant) ?? pending.proofDocumentId ?? null);
      await restaurant.save();
      return { account: view(), changed: true, changeRequested: true };
    }
    restaurant.set('payoutAccount.pendingChange', {
      accountHolderName: data.accountHolderName,
      accountNumberEncrypted: encryptField(data.accountNumber),
      accountNumberLast4: data.accountNumber.slice(-4),
      ifsc: data.ifsc,
      bankName: data.bankName ?? null,
      branch: data.branch ?? null,
      accountType: data.accountType,
      proofDocumentId: changeProofId(restaurant),
      status: 'in_review',
      // Strictly increasing, so an admin's decision on an earlier request can never apply to this one.
      requestedAt: new Date(Math.max(Date.now(), (pending.requestedAt?.getTime?.() ?? 0) + 1)),
      infoRequest: { message: null, at: null, by: null },
      rejectionReason: null,
    });
    await restaurant.save();
    return { account: view(), changed: true, changeRequested: true };
  }

  if (current.status !== 'not_added' && sameDetails(current, data)) {
    return { account: view(), changed: false, changeRequested: false };
  }

  restaurant.payoutAccount = {
    accountHolderName: data.accountHolderName,
    accountNumberEncrypted: encryptField(data.accountNumber),
    accountNumberLast4: data.accountNumber.slice(-4),
    ifsc: data.ifsc,
    bankName: data.bankName ?? null,
    branch: data.branch ?? null,
    accountType: data.accountType,
    status: 'pending_verification',
    rejectionReason: null,
    submittedAt: new Date(),
    verifiedAt: null,
    verifiedBy: null,
    providerContactId: null,
    providerFundAccountId: null,
  };
  await restaurant.save();
  return { account: view(), changed: true, changeRequested: false };
};

/** Admin: the full account number, once, recorded in the activity log. */
export const revealAccountNumber = async (restaurantId, adminId, { which = 'current' } = {}) => {
  if (!['current', 'requested'].includes(which)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'which must be "current" or "requested"');
  }
  const restaurant = await Restaurant.findById(restaurantId).select(`${SECRET_PATH} ${PENDING_SECRET_PATH}`).lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const source = which === 'requested' ? restaurant.payoutAccount?.pendingChange : restaurant.payoutAccount;
  const encrypted = which === 'requested' && !source?.status ? null : source?.accountNumberEncrypted;
  if (!encrypted) {
    throw new ApiError(404, 'NOT_FOUND', which === 'requested' ? 'There is no requested bank account change' : 'This restaurant has no bank account on file');
  }

  const accountNumber = decryptField(encrypted);
  await logActivity({
    adminId,
    action: which === 'requested' ? 'payout_account.reveal_requested' : 'payout_account.reveal',
    targetType: 'restaurant',
    targetId: restaurant._id,
    metadata: { accountNumberLast4: source.accountNumberLast4, which },
  });
  return { accountNumber, which, account: payoutAccountView(restaurant) };
};

// `submittedAt` is what the admin was looking at (the account view's submittedAt): if the owner
// changed the account since — after the admin revealed and checked it — the decision is refused
// instead of approving details nobody checked. The write is conditional for the same reason.
const decide = async (restaurantId, adminId, { status, reason, submittedAt }) => {
  const restaurant = await Restaurant.findById(restaurantId).select('payoutAccount documents').lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const pa = restaurant.payoutAccount;
  if (!pa || pa.status === 'not_added') {
    throw new ApiError(409, 'NO_PAYOUT_ACCOUNT', 'This restaurant has not added a bank account yet');
  }
  if (pa.status !== 'pending_verification') {
    throw new ApiError(409, 'NOT_PENDING_VERIFICATION', `This bank account is already ${pa.status.replace('_', ' ')}`);
  }
  const expected = submittedAt ? new Date(submittedAt) : null;
  if (!expected || Number.isNaN(expected.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', "submittedAt (the account's submittedAt you checked) is required");
  }
  const changed = () =>
    new ApiError(409, 'ACCOUNT_CHANGED', 'The restaurant changed its bank account since you opened it — check the new details');
  if (!pa.submittedAt || new Date(pa.submittedAt).getTime() !== expected.getTime()) throw changed();

  const updated = await Restaurant.findOneAndUpdate(
    { _id: restaurant._id, 'payoutAccount.status': 'pending_verification', 'payoutAccount.submittedAt': pa.submittedAt },
    {
      $set: {
        'payoutAccount.status': status,
        'payoutAccount.rejectionReason': status === 'rejected' ? reason : null,
        'payoutAccount.verifiedAt': status === 'verified' ? new Date() : null,
        'payoutAccount.verifiedBy': status === 'verified' ? adminId : null,
      },
    },
    { new: true, projection: 'payoutAccount documents' }
  ).lean();
  if (!updated) throw changed();

  await logActivity({
    adminId,
    action: status === 'verified' ? 'payout_account.verify' : 'payout_account.reject',
    targetType: 'restaurant',
    targetId: restaurant._id,
    metadata: { accountNumberLast4: pa.accountNumberLast4, ...(reason ? { reason } : {}) },
  });
  return payoutAccountView(updated);
};

export const verifyPayoutAccount = (restaurantId, adminId, { submittedAt } = {}) =>
  decide(restaurantId, adminId, { status: 'verified', submittedAt });

export const rejectPayoutAccount = (restaurantId, adminId, reason, { submittedAt } = {}) => {
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A reason is required to reject a bank account');
  }
  return decide(restaurantId, adminId, { status: 'rejected', reason: String(reason).trim(), submittedAt });
};

// ── Change requests (B12 task 3) ──────────────────────────────────────────────

// `requestedAt` is the request the admin was looking at: if the owner changed it since, the
// decision is refused (409 ACCOUNT_CHANGED) rather than applied to details nobody checked.
const loadOpenRequest = async (restaurantId, requestedAt, { withSecret = false } = {}) => {
  const restaurant = await Restaurant.findById(restaurantId)
    .select(withSecret ? `${SECRET_PATH} ${PENDING_SECRET_PATH}` : 'payoutAccount documents')
    .lean();
  if (!restaurant) throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  const pc = restaurant.payoutAccount?.pendingChange;
  if (!OPEN_REQUEST_STATUSES.includes(pc?.status)) {
    throw new ApiError(409, 'NO_OPEN_REQUEST', 'There is no open bank account change request for this restaurant');
  }
  const expected = requestedAt ? new Date(requestedAt) : null;
  if (!expected || Number.isNaN(expected.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', "requestedAt (the request's requestedAt you checked) is required");
  }
  if (new Date(pc.requestedAt).getTime() !== expected.getTime()) throw requestChanged();
  return restaurant;
};
const requestChanged = () =>
  new ApiError(409, 'ACCOUNT_CHANGED', 'The restaurant changed its request since you opened it — check the new details');
const openRequestFilter = (restaurant) => ({
  _id: restaurant._id,
  'payoutAccount.status': 'verified',
  'payoutAccount.pendingChange.status': { $in: OPEN_REQUEST_STATUSES },
  'payoutAccount.pendingChange.requestedAt': restaurant.payoutAccount.pendingChange.requestedAt,
});
const VIEW_PROJECTION = 'payoutAccount documents';

/** Verify: the requested account replaces the verified one (and is verified). */
export const verifyChangeRequest = async (restaurantId, adminId, { requestedAt } = {}) => {
  const restaurant = await loadOpenRequest(restaurantId, requestedAt, { withSecret: true });
  const pa = restaurant.payoutAccount;
  const pc = pa.pendingChange;
  const now = new Date();
  const updated = await Restaurant.findOneAndUpdate(
    openRequestFilter(restaurant),
    {
      $set: {
        'payoutAccount.accountHolderName': pc.accountHolderName,
        'payoutAccount.accountNumberEncrypted': pc.accountNumberEncrypted,
        'payoutAccount.accountNumberLast4': pc.accountNumberLast4,
        'payoutAccount.ifsc': pc.ifsc,
        'payoutAccount.bankName': pc.bankName ?? null,
        'payoutAccount.branch': pc.branch ?? null,
        'payoutAccount.accountType': pc.accountType,
        'payoutAccount.status': 'verified',
        'payoutAccount.rejectionReason': null,
        'payoutAccount.submittedAt': pc.requestedAt,
        'payoutAccount.verifiedAt': now,
        'payoutAccount.verifiedBy': adminId,
        // The provider's beneficiary records point at the old account.
        'payoutAccount.providerContactId': null,
        'payoutAccount.providerFundAccountId': null,
      },
      $unset: { 'payoutAccount.pendingChange': '' },
    },
    { new: true, projection: VIEW_PROJECTION }
  ).lean();
  if (!updated) throw requestChanged();

  // The new account's proof becomes the account's verified bank_statement (the old one goes —
  // it was evidence for the account that is no longer on file).
  const changeProof = (updated.documents ?? []).find((d) => d.type === 'bank_statement_change');
  if (changeProof) {
    await Restaurant.updateOne({ _id: restaurant._id }, { $pull: { documents: { type: 'bank_statement' } } });
    await Restaurant.updateOne(
      { _id: restaurant._id, 'documents._id': changeProof._id },
      { $set: { 'documents.$.type': 'bank_statement', 'documents.$.status': 'verified' } }
    );
  }

  await logActivity({
    adminId,
    action: 'payout_account.change_verify',
    targetType: 'restaurant',
    targetId: restaurant._id,
    metadata: { fromLast4: pa.accountNumberLast4, toLast4: pc.accountNumberLast4 },
  });
  return payoutAccountView(changeProof ? await Restaurant.findById(restaurant._id).select(VIEW_PROJECTION).lean() : updated);
};

/** Reject: the verified account stays; the owner sees the reason and may submit again. */
export const rejectChangeRequest = async (restaurantId, adminId, reason, { requestedAt } = {}) => {
  if (!reason || !String(reason).trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A reason is required to reject a bank account change');
  }
  const restaurant = await loadOpenRequest(restaurantId, requestedAt);
  const updated = await Restaurant.findOneAndUpdate(
    openRequestFilter(restaurant),
    { $set: { 'payoutAccount.pendingChange.status': 'rejected', 'payoutAccount.pendingChange.rejectionReason': String(reason).trim() } },
    { new: true, projection: VIEW_PROJECTION }
  ).lean();
  if (!updated) throw requestChanged();
  await logActivity({
    adminId,
    action: 'payout_account.change_reject',
    targetType: 'restaurant',
    targetId: restaurant._id,
    metadata: { requestedLast4: restaurant.payoutAccount.pendingChange.accountNumberLast4, reason: String(reason).trim() },
  });
  return payoutAccountView(updated);
};

/** Ask the owner for information: awaiting_restaurant until the owner resubmits. */
export const requestChangeInfo = async (restaurantId, adminId, message, { requestedAt } = {}) => {
  if (!message || !String(message).trim()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A message for the restaurant is required');
  }
  const restaurant = await loadOpenRequest(restaurantId, requestedAt);
  const updated = await Restaurant.findOneAndUpdate(
    openRequestFilter(restaurant),
    {
      $set: {
        'payoutAccount.pendingChange.status': 'awaiting_restaurant',
        'payoutAccount.pendingChange.infoRequest': { message: String(message).trim(), at: new Date(), by: adminId },
      },
    },
    { new: true, projection: VIEW_PROJECTION }
  ).lean();
  if (!updated) throw requestChanged();
  await logActivity({
    adminId,
    action: 'payout_account.change_request_info',
    targetType: 'restaurant',
    targetId: restaurant._id,
    metadata: { requestedLast4: restaurant.payoutAccount.pendingChange.accountNumberLast4 },
  });
  return payoutAccountView(updated);
};

// The settlement a bank change would affect — the restaurant's open payout, as the transfer
// axis the design shows ("₹2,278.14 / Scheduled · Mon 12 Oct").
const OPEN_SETTLEMENT_STATUSES = ['draft', 'approved', 'processing', 'failed', 'on_hold'];
const TRANSFER_STATUS = { draft: 'not_scheduled', approved: 'scheduled', processing: 'processing', failed: 'failed', on_hold: 'not_scheduled' };
const affectedPayouts = async (restaurantIds) => {
  if (!restaurantIds.length) return new Map();
  const rows = await RestaurantSettlement.find({ restaurantId: { $in: restaurantIds }, status: { $in: OPEN_SETTLEMENT_STATUSES } })
    .select('restaurantId status periodStart periodEnd totals.netPayable payout.scheduledFor')
    .sort({ periodStart: -1 })
    .lean();
  const byRestaurant = new Map();
  for (const s of rows) {
    const key = String(s.restaurantId);
    if (byRestaurant.has(key)) continue; // the latest open one
    byRestaurant.set(key, {
      settlementId: s._id,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      netPayablePaise: s.totals?.netPayable ?? 0,
      eligibility: s.status === 'on_hold' ? 'on_hold' : 'eligible',
      transferStatus: TRANSFER_STATUS[s.status],
      scheduledFor: s.payout?.scheduledFor ?? null,
    });
  }
  return byRestaurant;
};

/** Open requests (and their counts) for the admin "Bank requests" tab. */
export const countOpenBankRequests = async () => {
  const [open, awaitingRestaurant] = await Promise.all([
    Restaurant.countDocuments({ 'payoutAccount.pendingChange.status': { $in: OPEN_REQUEST_STATUSES } }),
    Restaurant.countDocuments({ 'payoutAccount.pendingChange.status': 'awaiting_restaurant' }),
  ]);
  return { open, awaitingRestaurant };
};

const REQUEST_STATUS_FILTERS = {
  open: OPEN_REQUEST_STATUSES,
  in_review: ['in_review'],
  awaiting_restaurant: ['awaiting_restaurant'],
  rejected: ['rejected'],
  all: ['in_review', 'awaiting_restaurant', 'rejected'],
};

export const listBankRequests = async ({ status = 'open', page = 1, limit = 20 } = {}) => {
  const statuses = REQUEST_STATUS_FILTERS[status];
  if (!statuses) throw new ApiError(400, 'VALIDATION_ERROR', `status must be one of ${Object.keys(REQUEST_STATUS_FILTERS).join(', ')}`);
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { 'payoutAccount.pendingChange.status': { $in: statuses } };
  const [restaurants, total, counts] = await Promise.all([
    Restaurant.find(filter)
      .select('name payoutAccount documents')
      .sort({ 'payoutAccount.pendingChange.requestedAt': 1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Restaurant.countDocuments(filter),
    countOpenBankRequests(),
  ]);
  const affects = await affectedPayouts(restaurants.map((r) => new mongoose.Types.ObjectId(String(r._id))));
  return {
    requests: restaurants.map((r) => ({
      restaurantId: r._id,
      restaurantName: r.name,
      receivedAt: r.payoutAccount.pendingChange.requestedAt,
      currentAccountLast4: r.payoutAccount.accountNumberLast4 ?? null,
      requestedAccountLast4: r.payoutAccount.pendingChange.accountNumberLast4 ?? null,
      requestStatus: r.payoutAccount.pendingChange.status,
      affects: affects.get(String(r._id)) ?? null,
      request: pendingChangeView(r),
    })),
    total,
    page: p,
    limit: l,
    counts,
  };
};
