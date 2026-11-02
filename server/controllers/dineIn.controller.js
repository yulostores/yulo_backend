import mongoose from 'mongoose';
import { z } from 'zod';
import User from '../models/User.js';
import Table from '../models/Table.js';
import MenuItem from '../models/MenuItem.js';
import Discount from '../models/Discount.js';
import Restaurant from '../models/Restaurant.js';
import * as activityService from '../services/activity.service.js';
import { dishNamesFor, markOfferViewed, toCustomerOfferView } from '../services/personalOffer.service.js';
import { publishOffer } from '../services/liveBroadcast.service.js';
import { DINER_TOKEN_SECONDS, generateDinerToken } from '../services/auth.service.js';
import { isLiveActivityEnabledFor } from '../config/liveActivity.config.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { now } from '../utils/clock.js';

// Live customer activity for diners at a table (yulo_menu, the table QR). The menu app has no
// login, so a diner is a bare guest user whose token names the restaurant + table it was issued
// at (POST …/diner). With that token, the app's ordinary requests (menu, item, order, waiter,
// bill) are recorded against the table on the owner's live dashboard, the cart the phone holds
// is synced here, and an offer the owner sends that diner is read back and comes off the
// table's bill (billing.service.js). Nothing here is needed to order: with the feature off for
// the restaurant no token is issued and the menu works exactly as before.

const MAX_CART_LINES = 50;

const cartBody = z
  .object({
    items: z
      .array(
        z.object({
          menuItemId: z.string().regex(/^[a-f\d]{24}$/i, 'must be an id'),
          quantity: z.number().int().min(1).max(99),
        })
      )
      .max(MAX_CART_LINES),
  })
  .strict();

/** The diner's token was issued at this restaurant's table — else 401 (a stale or other token). */
const requireDiner = (req) => {
  const dineIn = activityService.dineInOf(req, req.publicRestaurant._id);
  if (!dineIn || dineIn.tableId !== String(req.params.tableId)) {
    throw new ApiError(401, 'DINER_TOKEN_REQUIRED', 'Scan the table QR again');
  }
  return dineIn;
};

// POST /api/restaurants/:id/tables/:tableId/diner → { token, expiresAt } — or { token: null }
// while live activity is off for the restaurant (the app then just doesn't send one).
export const startDiner = asyncHandler(async (req, res) => {
  const restaurantId = req.publicRestaurant._id;
  if (!isLiveActivityEnabledFor(restaurantId)) return sendSuccess(res, 200, 'Live activity is off', { token: null });
  if (!mongoose.isValidObjectId(req.params.tableId)) throw new ApiError(404, 'NOT_FOUND', 'Table not found');
  const table = await Table.findOne({ _id: req.params.tableId, restaurantId, isActive: true }).select('qrCode.status').lean();
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');
  if (table.qrCode?.status === 'void') throw new ApiError(400, 'QR_VOID', 'QR code has been voided — rescan with the new QR');

  const user = await User.create({ role: 'guest', name: 'Guest' });
  const token = generateDinerToken(user._id, { restaurantId, tableId: table._id });
  sendSuccess(res, 201, 'Diner started', {
    token,
    expiresAt: new Date(now().getTime() + DINER_TOKEN_SECONDS * 1000).toISOString(),
  });
});

// PUT /api/restaurants/:id/tables/:tableId/cart — the cart the diner's phone holds now. Priced
// here from the menu (never the phone's prices); recorded as cart events after the response.
export const syncCart = asyncHandler(async (req, res) => {
  requireDiner(req);
  const parsed = cartBody.safeParse(req.body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid cart', parsed.error.flatten());

  const qtyOf = new Map();
  for (const line of parsed.data.items) qtyOf.set(line.menuItemId, (qtyOf.get(line.menuItemId) ?? 0) + line.quantity);
  const items = qtyOf.size
    ? await MenuItem.find({ _id: { $in: [...qtyOf.keys()] }, restaurantId: req.publicRestaurant._id })
        .select('name sellingPrice discountedPrice')
        .lean()
    : [];
  // In the phone's order; dishes no longer on this menu are dropped.
  const byId = new Map(items.map((item) => [String(item._id), item]));
  const lines = [...qtyOf.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, qty]) => {
      const item = byId.get(id);
      return { menuItemId: item._id, name: item.name, qty, unitPrice: item.discountedPrice ?? item.sellingPrice ?? 0 };
    });

  sendSuccess(res, 202, 'Cart received', { lines: lines.length });
  void activityService.recordDineInCart(req, req.publicRestaurant._id, lines);
});

// GET /api/restaurants/:id/tables/:tableId/offer → { offer | null } — the open offer the owner
// sent this diner at this table. Reading it is delivery (sent → delivered).
export const getTableOffer = asyncHandler(async (req, res) => {
  const { tableId } = requireDiner(req);
  const at = now();
  const restaurantId = req.publicRestaurant._id;
  if (!isLiveActivityEnabledFor(restaurantId)) return sendSuccess(res, 200, 'No offer', { offer: null });
  let offer = await Discount.findOne({
    kind: 'personal',
    restaurantId,
    tableId,
    targetUserId: req.user._id,
    isOpen: true,
    endDate: { $gt: at },
  }).lean();
  if (!offer) return sendSuccess(res, 200, 'No offer', { offer: null });
  if (offer.offerStatus === 'sent') {
    const delivered = await Discount.findOneAndUpdate(
      { _id: offer._id, offerStatus: 'sent' },
      { $set: { offerStatus: 'delivered', deliveredAt: at } },
      { new: true, lean: true }
    );
    if (delivered) {
      offer = delivered;
      await publishOffer(delivered, { at });
    }
  }
  const [restaurant, dishName] = await Promise.all([
    Restaurant.findById(restaurantId).select('name').lean(),
    dishNamesFor([offer]),
  ]);
  sendSuccess(res, 200, 'Offer', { offer: toCustomerOfferView(offer, restaurant?.name, dishName) });
});

// POST /api/restaurants/:id/tables/:tableId/offer/:offerId/view — the diner opened the offer.
export const viewTableOffer = asyncHandler(async (req, res) => {
  requireDiner(req);
  const { offer, firstView } = await markOfferViewed(req.user, req.params.offerId);
  if (String(offer.restaurant.id) !== String(req.publicRestaurant._id)) throw new ApiError(404, 'OFFER_NOT_FOUND', 'Offer not found');
  sendSuccess(res, 200, 'Offer viewed', { offer });
  if (firstView) void activityService.record(req, req.publicRestaurant._id, 'offer_viewed', { offerId: offer.id });
});
