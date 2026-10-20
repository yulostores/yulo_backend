import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as payoutAccountService from '../../services/payoutAccount.service.js';

const assertId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid store id');
};

// GET /api/admin/stores/:id/payout-account — masked, with the proof document's status.
export const getPayoutAccount = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Bank account', { account: await payoutAccountService.getPayoutAccount(req.params.id) });
});

// POST /api/admin/stores/:id/payout-account/reveal — the full account number, to check it
// against the proof. Every reveal is written to the admin activity log.
// Body { which?: "current" | "requested" } — "requested" reveals an open change request's number.
export const revealPayoutAccount = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = z.object({ which: z.enum(['current', 'requested']).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const result = await payoutAccountService.revealAccountNumber(req.params.id, req.user._id, parsed.data);
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Bank account number', result);
});

// The account's submittedAt as the admin saw it — the decision is refused (409 ACCOUNT_CHANGED)
// if the owner has changed the account since.
const submittedAt = z.string().datetime({ offset: true }).optional();

// PATCH /api/admin/stores/:id/payout-account/verify — body { submittedAt }.
export const verifyPayoutAccount = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = z.object({ submittedAt }).safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  sendSuccess(res, 200, 'Bank account verified', {
    account: await payoutAccountService.verifyPayoutAccount(req.params.id, req.user._id, parsed.data),
  });
});

const rejectSchema = z.object({ reason: z.string().trim().min(3).max(300), submittedAt });

// PATCH /api/admin/stores/:id/payout-account/reject — body { reason, submittedAt } (reason is
// shown to the owner).
export const rejectPayoutAccount = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const parsed = rejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A reason (3–300 characters) is required', parsed.error.flatten());
  }
  sendSuccess(res, 200, 'Bank account rejected', {
    account: await payoutAccountService.rejectPayoutAccount(req.params.id, req.user._id, parsed.data.reason, parsed.data),
  });
});

// ── Bank account change requests (B12) ────────────────────────────────────────

// The request's requestedAt as the admin saw it — refused (409 ACCOUNT_CHANGED) if the owner
// changed the request since.
const requestedAt = z.string().datetime({ offset: true });
const parseOr400 = (schema, body, message = 'Invalid request') => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

// PATCH /api/admin/stores/:id/payout-account/change/verify — body { requestedAt }. The
// requested account replaces the verified one.
export const verifyChangeRequest = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const data = parseOr400(z.object({ requestedAt }), req.body, 'requestedAt is required');
  sendSuccess(res, 200, 'Bank account change verified', {
    account: await payoutAccountService.verifyChangeRequest(req.params.id, req.user._id, data),
  });
});

// PATCH /api/admin/stores/:id/payout-account/change/reject — body { reason (3–300), requestedAt }.
export const rejectChangeRequest = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const data = parseOr400(
    z.object({ reason: z.string().trim().min(3).max(300), requestedAt }),
    req.body,
    'A reason (3–300 characters) and requestedAt are required'
  );
  sendSuccess(res, 200, 'Bank account change rejected', {
    account: await payoutAccountService.rejectChangeRequest(req.params.id, req.user._id, data.reason, data),
  });
});

// PATCH /api/admin/stores/:id/payout-account/change/request-info — body { message (3–500),
// requestedAt }. The request waits for the restaurant (awaiting_restaurant) until it resubmits.
export const requestChangeInfo = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const data = parseOr400(
    z.object({ message: z.string().trim().min(3).max(500), requestedAt }),
    req.body,
    'A message (3–500 characters) and requestedAt are required'
  );
  sendSuccess(res, 200, 'Information requested from the restaurant', {
    account: await payoutAccountService.requestChangeInfo(req.params.id, req.user._id, data.message, data),
  });
});

// GET /api/admin/bank-requests?status=open|in_review|awaiting_restaurant|rejected|all&page&limit
// — bank account change requests across restaurants (the Payouts "Bank requests" tab), each
// with the open payout it would affect, plus counts { open, awaitingRestaurant }.
export const listBankRequests = asyncHandler(async (req, res) => {
  const q = parseOr400(
    z.object({
      status: z.enum(['open', 'in_review', 'awaiting_restaurant', 'rejected', 'all']).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    req.query
  );
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Bank requests', await payoutAccountService.listBankRequests(q));
});
