import * as personalOfferService from '../services/personalOffer.service.js';
import * as activityService from '../services/activity.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// A customer's personal offers (live customer activity). Behind routes/offer.routes.js.

export const listMine = asyncHandler(async (req, res) => {
  const offers = await personalOfferService.listMyOffers(req.user);
  sendSuccess(res, 200, 'Your offers', { offers });
});

export const markViewed = asyncHandler(async (req, res) => {
  const { offer, firstView } = await personalOfferService.markOfferViewed(req.user, req.params.offerId);
  sendSuccess(res, 200, 'Offer viewed', { offer });
  // Once per offer: only the call that moved it to `viewed` records the event.
  if (firstView) void activityService.record(req, offer.restaurant.id, 'offer_viewed', { offerId: offer.id });
});
