/**
 * guestAccount.service.js — folding an anonymous guest session into a real customer.
 *
 * A guest browses, adds to cart and favorites things under its own throwaway `User`
 * document (role: 'guest', no phone — see controllers/auth.controller.js's guestLogin).
 * When that session completes a real phone+OTP verify, one of two things happens
 * (both driven from verifyCustomerOtp):
 *
 *   - The phone is brand new → the guest document is upgraded in place (phone + role
 *     flip to 'customer'). Same `_id`, so its cart/favorites/addresses need no work at
 *     all — this file is never called for that path.
 *   - The phone already belongs to an existing customer → that's the common case for
 *     anyone who's used the app before. This file merges the guest's activity into the
 *     existing account, then deletes the guest record.
 *
 * Every merge step is best-effort and independent: a duplicate favorite or an
 * unreadable cart never blocks the ones that already succeeded, and none of it blocks
 * the login itself.
 */

import Cart from '../models/Cart.js';
import Favorite from '../models/Favorite.js';
import SearchHistory from '../models/SearchHistory.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

/**
 * @param {import('mongoose').Document} guestUser  The guest's User document.
 * @param {import('mongoose').Document} targetUser The real customer account signing in.
 */
export async function mergeGuestIntoCustomer(guestUser, targetUser) {
  const guestId = guestUser._id;
  const targetId = targetUser._id;

  // Sequential, not Promise.all: each step is caught on its own so one failure (a
  // transient DB hiccup, a duplicate-key collision) never stops the rest from
  // running, and never bubbles up to fail the login itself — see
  // controllers/auth.controller.js's verifyCustomerOtp, which also wraps this whole
  // call as a backstop.
  const steps = [
    ['cart', () => mergeCart(guestId, targetId)],
    ['favorites', () => mergeFavorites(guestId, targetId)],
    ['searchHistory', () => SearchHistory.updateMany({ userId: guestId }, { $set: { userId: targetId } })],
    ['addresses', () => mergeAddresses(guestUser, targetUser)],
  ];

  for (const [step, run] of steps) {
    try {
      await run();
    } catch (err) {
      logger.warn(
        { err: { name: err?.name, message: err?.message }, step, guestId: String(guestId), targetId: String(targetId) },
        'Guest merge step failed — continuing with the rest'
      );
    }
  }

  try {
    await User.deleteOne({ _id: guestId });
  } catch (err) {
    logger.warn(
      { err: { name: err?.name, message: err?.message }, guestId: String(guestId) },
      'Could not delete the guest record after merge — cleanupStaleGuests.js will reap it eventually'
    );
  }
}

// Cart.userId is unique — the target can hold at most one. The guest's cart wins only
// when the target doesn't already have one in progress; reconciling two different
// restaurants' worth of line items isn't worth the complexity for what should be a rare
// collision, so the target's own cart is left untouched and the guest's is discarded.
async function mergeCart(guestId, targetId) {
  const guestCart = await Cart.findOne({ userId: guestId });
  if (!guestCart) return;

  if (guestCart.items.length === 0) {
    await Cart.deleteOne({ _id: guestCart._id });
    return;
  }

  const targetCart = await Cart.findOne({ userId: targetId });
  if (targetCart && targetCart.items.length > 0) {
    await Cart.deleteOne({ _id: guestCart._id });
    return;
  }

  if (targetCart) await Cart.deleteOne({ _id: targetCart._id });
  guestCart.userId = targetId;
  await guestCart.save();
}

// (userId, entityType, entityId) is unique, so anything the target already favorited
// would collide — those are just dropped, not treated as a failure.
async function mergeFavorites(guestId, targetId) {
  const guestFavorites = await Favorite.find({ userId: guestId }).lean();
  if (guestFavorites.length === 0) return;

  const targetFavorites = await Favorite.find({ userId: targetId }).select('entityType entityId').lean();
  const existingKeys = new Set(targetFavorites.map((f) => `${f.entityType}:${f.entityId}`));

  const toInsert = guestFavorites
    .filter((f) => !existingKeys.has(`${f.entityType}:${f.entityId}`))
    .map((f) => ({ userId: targetId, entityType: f.entityType, entityId: f.entityId }));

  await Favorite.deleteMany({ userId: guestId });
  if (toInsert.length > 0) {
    await Favorite.insertMany(toInsert, { ordered: false }).catch(() => {});
  }
}

// Saved addresses live embedded on the User document rather than their own collection.
// Append any the target doesn't already have (matched loosely on street + pincode) so a
// guest who picked a delivery address before signing in doesn't lose it — never as the
// new default, since the target's own default (if any) should stay the default.
async function mergeAddresses(guestUser, targetUser) {
  const guestAddresses = guestUser.savedAddresses || [];
  if (guestAddresses.length === 0) return;

  const existingKeys = new Set(
    (targetUser.savedAddresses || []).map((a) => `${a.street ?? ''}|${a.pincode ?? ''}`)
  );

  let changed = false;
  for (const addr of guestAddresses) {
    const key = `${addr.street ?? ''}|${addr.pincode ?? ''}`;
    if (existingKeys.has(key)) continue;
    const plain = typeof addr.toObject === 'function' ? addr.toObject() : addr;
    const { _id, ...rest } = plain;
    targetUser.savedAddresses.push({ ...rest, isDefault: false });
    changed = true;
  }

  if (changed) await targetUser.save();
}
