import mongoose from 'mongoose';
import { z } from 'zod';
import * as adminSellers from '../../services/adminSeller.service.js';
import * as subscriptions from '../../services/sellerSubscription.service.js';
import { streamDocument } from '../../services/restaurantDocument.service.js';
import { SELLER_STATUSES } from '../../config/coupon.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { receivedOnSchema } from '../../utils/receivedOn.js';

// Super admin — coupon partners (services/adminSeller.service.js holds the rules).

const assertId = (id, label = 'seller') => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${label} id`);
};

const parseOr400 = (schema, input, message = 'Invalid request') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

const listQuery = z.object({
  status: z.enum(SELLER_STATUSES).optional(),
  categoryId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid category').optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/sellers */
export const list = asyncHandler(async (req, res) => {
  const query = parseOr400(listQuery, req.query, 'Invalid filters');
  sendSuccess(res, 200, 'Sellers', await adminSellers.listSellers(query));
});

/** GET /api/admin/sellers/:id */
export const getOne = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Seller', { seller: await adminSellers.getSeller(req.params.id) });
});

/** GET /api/admin/sellers/:id/users */
export const users = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Seller users', { users: await adminSellers.listSellerUsers(req.params.id) });
});

/** POST /api/admin/sellers/:id/reveal  { field: "pan" | "aadhaar" } — audit-logged. */
export const reveal = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const { field } = parseOr400(z.object({ field: z.enum(['pan', 'aadhaar']) }).strict(), req.body, 'field must be "pan" or "aadhaar"');
  const result = await adminSellers.revealIdentity(req.params.id, req.user._id, field);
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, 'Identity number', result);
});

/** PATCH /api/admin/sellers/:id/approve */
export const approve = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Seller approved', { seller: await adminSellers.approveSeller(req.params.id, req.user._id) });
});

/** PATCH /api/admin/sellers/:id/reject  { reason } — the reason is shown to the owner. */
export const reject = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const { reason } = parseOr400(
    z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
    req.body,
    'A reason (3–500 characters) is required'
  );
  sendSuccess(res, 200, 'Seller rejected', { seller: await adminSellers.rejectSeller(req.params.id, req.user._id, reason) });
});

/** PATCH /api/admin/sellers/:id/suspend  { reason? } — signs every user of the seller out. */
export const suspend = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const { reason } = parseOr400(z.object({ reason: z.string().trim().max(500).optional() }).strict(), req.body);
  sendSuccess(res, 200, 'Seller suspended', { seller: await adminSellers.suspendSeller(req.params.id, req.user._id, reason ?? null) });
});

/** PATCH /api/admin/sellers/:id/reactivate */
export const reactivate = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Seller reactivated', { seller: await adminSellers.reactivateSeller(req.params.id, req.user._id) });
});

/** GET /api/admin/sellers/:id/documents/:docId/file */
export const documentFile = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  assertId(req.params.docId, 'document');
  await streamDocument(await adminSellers.findDocument(req.params.id, req.params.docId), res);
});

// ── Plans (CB4) ───────────────────────────────────────────────────────────────

const manualPaymentSchema = z
  .object({
    planKey: z.string().trim().min(1).max(40),
    amountRupees: z.number().positive().max(10_000_000),
    mode: z.enum(['neft', 'upi', 'cash', 'cheque', 'other']),
    // A bank UTR, UPI reference, cheque or receipt number — what proves this payment, and what
    // stops it being recorded twice.
    reference: z.string().trim().min(3, 'Enter the payment reference').max(100),
    receivedOn: receivedOnSchema,
    note: z.string().trim().max(500).optional(),
    overrideReason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

/** POST /api/admin/sellers/:id/subscriptions/manual — "Amount Received". */
export const recordManualPayment = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  const body = parseOr400(manualPaymentSchema, req.body, 'Invalid payment details');
  const subscription = await subscriptions.recordManualPayment(req.params.id, req.user._id, {
    ...body,
    planKey: body.planKey.toLowerCase(),
  });
  sendSuccess(res, 201, 'Payment recorded — plan activated', { subscription: subscriptions.adminSubscriptionView(subscription) });
});

/** GET /api/admin/sellers/:id/subscriptions */
export const listSubscriptions = asyncHandler(async (req, res) => {
  assertId(req.params.id);
  sendSuccess(res, 200, 'Subscriptions', { subscriptions: await subscriptions.adminSubscriptions(req.params.id) });
});
