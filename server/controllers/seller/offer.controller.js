import { z } from 'zod';
import * as offers from '../../services/couponOffer.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — the business's coupon offers (services/couponOffer.service.js). Owner and
// manager; approved sellers only (routes/seller/index.js).

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid offer id');
const parseOr400 = (schema, input, message = 'Invalid offer') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};
const offerId = (req) => parseOr400(objectId, req.params.id, 'Invalid offer id');

/** GET /api/seller/offers */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Offers', { offers: await offers.listSellerOffers(req.seller.sellerId) });
});

/** POST /api/seller/offers  { title, terms?, validityDays? } — a draft in the seller's category. */
export const create = asyncHandler(async (req, res) => {
  const body = parseOr400(offers.createOfferSchema, req.body);
  sendSuccess(res, 201, 'Offer saved as a draft', { offer: await offers.createOffer(req.seller.sellerId, req.seller.userId, body) });
});

/** PATCH /api/seller/offers/:id — an approved or paused offer goes back to review. */
export const update = asyncHandler(async (req, res) => {
  const id = offerId(req);
  const patch = parseOr400(offers.updateOfferSchema, req.body);
  const offer = await offers.updateOffer(req.seller.sellerId, id, patch);
  sendSuccess(res, 200, offer.status === 'pending_review' ? 'Offer saved — sent for review' : 'Offer saved', { offer });
});

/** POST /api/seller/offers/:id/submit */
export const submit = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Offer sent for review', { offer: await offers.submitOffer(req.seller.sellerId, offerId(req)) });
});

/** POST /api/seller/offers/:id/pause */
export const pause = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Offer paused', { offer: await offers.pauseOffer(req.seller.sellerId, offerId(req)) });
});

/** POST /api/seller/offers/:id/resume */
export const resume = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Offer running again', { offer: await offers.resumeOffer(req.seller.sellerId, offerId(req)) });
});
