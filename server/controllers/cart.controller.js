import * as cartService from '../services/cart.service.js';
import * as activityService from '../services/activity.service.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getCart = asyncHandler(async (req, res) => {
  const { cart, bill } = await cartService.getCart(req.user._id);
  sendSuccess(res, 200, 'Cart', { cart, bill });
});

export const addItem = asyncHandler(async (req, res) => {
  const { cart, bill } = await cartService.addItem(req.user._id, req.body);
  sendSuccess(res, 201, 'Item added to cart', { cart, bill });
  const line = cart.items.findLast((i) => String(i.menuItemId) === String(req.body.menuItemId));
  void activityService.record(req, cart.restaurantId, 'cart_item_added', {
    menuItemId: req.body.menuItemId,
    itemName: line?.name,
    qty: req.body.qty,
    deltaQty: req.body.qty,
    cart,
    bill,
  });
});

export const updateItem = asyncHandler(async (req, res) => {
  const { cart, bill, previous } = await cartService.updateItemQty(
    req.user._id,
    req.params.lineItemId,
    req.body.qty
  );
  sendSuccess(res, 200, 'Cart item updated', { cart, bill });
  // qty 0 removes the line (cart.service.js) — recorded as a removal.
  const removed = req.body.qty <= 0;
  void activityService.record(req, previous.restaurantId, removed ? 'cart_item_removed' : 'cart_qty_changed', {
    menuItemId: previous.menuItemId,
    itemName: previous.name,
    qty: removed ? 0 : req.body.qty,
    deltaQty: (removed ? 0 : req.body.qty) - previous.qty,
    cart,
    bill,
  });
});

export const removeItem = asyncHandler(async (req, res) => {
  const { cart, bill, previous } = await cartService.removeItem(req.user._id, req.params.lineItemId);
  sendSuccess(res, 200, 'Cart item removed', { cart, bill });
  void activityService.record(req, previous.restaurantId, 'cart_item_removed', {
    menuItemId: previous.menuItemId,
    itemName: previous.name,
    qty: 0,
    deltaQty: -previous.qty,
    cart,
    bill,
  });
});

export const clearCart = asyncHandler(async (req, res) => {
  const { cart, bill, previous } = await cartService.clearCart(req.user._id);
  sendSuccess(res, 200, 'Cart cleared', { cart, bill });
  // The restaurant the cart belonged to, read before clearing; an already-empty cart → nothing.
  if (previous.itemCount > 0) {
    void activityService.record(req, previous.restaurantId, 'cart_cleared', { cart, bill });
  }
});

export const applyOffer = asyncHandler(async (req, res) => {
  const { cart, bill, replacedPromo, offer } = await cartService.applyOffer(req.user._id, req.body.offerId);
  sendSuccess(res, 200, replacedPromo ? 'Offer applied — it replaces your promo code' : 'Offer applied', { cart, bill });
  void activityService.record(req, offer.restaurantId, 'offer_applied', { offerId: offer._id });
});

export const removeOffer = asyncHandler(async (req, res) => {
  const { cart, bill } = await cartService.removeOffer(req.user._id);
  sendSuccess(res, 200, 'Offer removed', { cart, bill });
});

export const removePromo = asyncHandler(async (req, res) => {
  const { cart, bill } = await cartService.removePromo(req.user._id);
  sendSuccess(res, 200, 'Promo removed', { cart, bill });
});

export const applyPromo = asyncHandler(async (req, res) => {
  const { cart, bill } = await cartService.applyPromo(req.user._id, req.body.code);
  sendSuccess(res, 200, 'Promo applied', { cart, bill });
});
