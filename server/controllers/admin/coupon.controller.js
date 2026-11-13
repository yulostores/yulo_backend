import mongoose from 'mongoose';
import { z } from 'zod';
import * as coupons from '../../services/couponOffer.service.js';
import { OFFER_STATUSES } from '../../config/coupon.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Super admin — coupon categories (the on/off switches customers' coupons follow) and the
// seller offer review queue (services/couponOffer.service.js).

const assertId = (id, label) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${label} id`);
};
const parseOr400 = (schema, input, message = 'Invalid request') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

// ── Categories ────────────────────────────────────────────────────────────────

/** GET /api/admin/coupon-categories */
export const listCategories = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon categories', { categories: await coupons.adminListCategories() });
});

/** POST /api/admin/coupon-categories  { key, name, icon?, sortOrder?, enabled? } */
export const createCategory = asyncHandler(async (req, res) => {
  const body = parseOr400(coupons.categorySchema, req.body, 'Invalid category');
  sendSuccess(res, 201, 'Category created', { category: await coupons.createCategory(req.user._id, body) });
});

/** PATCH /api/admin/coupon-categories/:id  { name?, icon?, sortOrder?, enabled? } */
export const updateCategory = asyncHandler(async (req, res) => {
  assertId(req.params.id, 'category');
  const patch = parseOr400(coupons.categoryPatchSchema, req.body, 'Invalid category');
  const category = await coupons.updateCategory(req.user._id, req.params.id, patch);
  const message = patch.enabled === undefined ? 'Category saved' : category.enabled ? 'Customers will now receive these coupons' : 'Customers will no longer receive these coupons';
  sendSuccess(res, 200, message, { category });
});

// ── Offer review ──────────────────────────────────────────────────────────────

const offerQuery = z.object({
  status: z.enum(OFFER_STATUSES).optional(),
  sellerId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid seller').optional(),
  categoryId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid category').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/admin/coupon-offers?status=pending_review */
export const listOffers = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon offers', await coupons.adminListOffers(parseOr400(offerQuery, req.query, 'Invalid filters')));
});

// The offer's updatedAt as the admin saw it (from the list). Optional, but the portal always
// sends it: a decision on an offer the seller has changed since is refused (409 OFFER_CHANGED).
const seenUpdatedAt = z.string().datetime({ offset: true }).optional();

/** PATCH /api/admin/coupon-offers/:id/approve  { updatedAt? } */
export const approveOffer = asyncHandler(async (req, res) => {
  assertId(req.params.id, 'offer');
  const { updatedAt } = parseOr400(z.object({ updatedAt: seenUpdatedAt }).strict(), req.body);
  sendSuccess(res, 200, 'Offer approved', { offer: await coupons.approveOffer(req.params.id, req.user._id, updatedAt) });
});

/** PATCH /api/admin/coupon-offers/:id/reject  { reason, updatedAt? } — the reason is shown to the seller. */
export const rejectOffer = asyncHandler(async (req, res) => {
  assertId(req.params.id, 'offer');
  const { reason, updatedAt } = parseOr400(
    z.object({ reason: z.string().trim().min(3).max(500), updatedAt: seenUpdatedAt }).strict(),
    req.body,
    'A reason (3–500 characters) is required'
  );
  sendSuccess(res, 200, 'Offer rejected', { offer: await coupons.rejectOffer(req.params.id, req.user._id, reason, updatedAt) });
});
