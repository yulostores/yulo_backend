import { z } from 'zod';
import * as personalOfferService from '../../services/personalOffer.service.js';
import { LIST_LIMITS, OFFER_LIMITS } from '../../config/liveActivity.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// The owner's live customer dashboard and personal offers. Every handler is behind
// authenticate → restaurant_owner → authorizeRestaurant → approved → the feature switch
// (routes/owner/live.routes.js), and every read is scoped to req.restaurant.

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be an id');

const parse = (schema, input) => {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', result.error.flatten());
  return result.data;
};

const sessionsQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(personalOfferService.LISTABLE_SESSION_STATUSES)).min(1).optional()),
  limit: z.coerce.number().int().min(1).max(LIST_LIMITS.sessionsMax).optional(),
});

const eventsQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMITS.eventsMax).optional(),
});

// Shape only (types, integers, known keys). The § Rules ranges are checked by the service in
// a fixed order, so each breaks with its own code (OFFER_TOO_LARGE, INVALID_EXPIRY, …).
// `.strict()`: the body can never set restaurantId, targetUserId, kind, offerStatus, …
const offerBody = z
  .object({
    sessionId: objectId,
    title: z.string().trim().min(1).max(OFFER_LIMITS.titleMaxLength),
    type: z.enum(['percentage', 'flat_amount']),
    percentage: z.number().int().optional(),
    flatAmount: z.number().int().optional(),
    maxDiscountAmount: z.number().int().optional(),
    minimumOrderValue: z.number().int().min(0).optional(),
    expiresInMinutes: z.number().int(),
    applicableItems: z.array(objectId).max(OFFER_LIMITS.applicableItemsMax).optional(),
    preview: z.boolean().optional(),
  })
  .strict()
  .refine((b) => !(b.type === 'percentage' && b.flatAmount != null) && !(b.type === 'flat_amount' && b.percentage != null), {
    message: 'Send percentage for a percentage offer, flatAmount for a flat one',
    path: ['type'],
  });

const offersQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMITS.offersMax).optional(),
});

const metricsQuery = z.object({
  range: z.enum(Object.keys(personalOfferService.METRIC_RANGES)).optional(),
});

export const listSessions = asyncHandler(async (req, res) => {
  const { status, limit } = parse(sessionsQuery, req.query);
  const data = await personalOfferService.listSessions(req.restaurant._id, {
    ...(status ? { statuses: status } : {}),
    ...(limit ? { limit } : {}),
  });
  sendSuccess(res, 200, 'Live sessions', data);
});

export const getSession = asyncHandler(async (req, res) => {
  const data = await personalOfferService.getSession(req.restaurant._id, req.params.sessionId);
  sendSuccess(res, 200, 'Live session', data);
});

export const listSessionEvents = asyncHandler(async (req, res) => {
  const { before, limit } = parse(eventsQuery, req.query);
  const data = await personalOfferService.listSessionEvents(req.restaurant._id, req.params.sessionId, {
    before,
    ...(limit ? { limit } : {}),
  });
  sendSuccess(res, 200, 'Session events', data);
});

export const createOffer = asyncHandler(async (req, res) => {
  const body = parse(offerBody, req.body);
  const result = await personalOfferService.createOffer({
    restaurantId: req.restaurant._id,
    ownerId: req.user._id,
    body,
  });
  if (result.preview) return sendSuccess(res, 200, 'Offer preview', result.preview);
  sendSuccess(res, 201, 'Offer sent', result);
});

export const revokeOffer = asyncHandler(async (req, res) => {
  const data = await personalOfferService.revokeOffer({ restaurantId: req.restaurant._id, offerId: req.params.offerId });
  sendSuccess(res, 200, 'Offer revoked', data);
});

export const listOffers = asyncHandler(async (req, res) => {
  const query = parse(offersQuery, req.query);
  const data = await personalOfferService.listOffers(req.restaurant._id, query);
  sendSuccess(res, 200, 'Personal offers', data);
});

export const getMetrics = asyncHandler(async (req, res) => {
  const { range } = parse(metricsQuery, req.query);
  const data = await personalOfferService.getMetrics(req.restaurant._id, range);
  sendSuccess(res, 200, 'Offer metrics', data);
});
