import User from '../models/User.js';
import UserDevice from '../models/UserDevice.js';
import {
  parseAddressInput,
  postalPartsChanged,
  resolveAddress,
} from './address.service.js';
import { ApiError } from '../utils/ApiError.js';

export const getPreferences = async (userId) => {
  const user = await User.findById(userId).select('preferences').lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return user.preferences;
};

// Merges rather than replaces: a body of just { vegModeEnabled } must not wipe out
// vegModeScope/notifications, and a `notifications.categories` update must upsert by
// `key` into the existing array rather than overwriting the whole list (the client only
// ever sends the categories that changed, not the full set — see screen 31's "Save
// changes" only covering dirtied toggles).
export const updatePreferences = async (userId, updates) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const { notifications, ...rest } = updates;
  Object.assign(user.preferences, rest);

  if (notifications) {
    const { categories, ...notificationRest } = notifications;
    Object.assign(user.preferences.notifications, notificationRest);

    if (Array.isArray(categories)) {
      for (const incoming of categories) {
        const existing = user.preferences.notifications.categories.find(
          (c) => c.key === incoming.key
        );
        if (existing) {
          existing.enabled = incoming.enabled;
        } else {
          user.preferences.notifications.categories.push(incoming);
        }
      }
    }
  }

  await user.save();
  return user.preferences;
};

export const registerDevice = (userId, deviceToken, platform) =>
  UserDevice.findOneAndUpdate(
    { deviceToken },
    { userId, deviceToken, platform },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

export const removeDevice = (userId, deviceToken) =>
  UserDevice.deleteOne({ userId, deviceToken });

// Validation, coordinate resolution and the composed `street` line all live in
// services/address.service.js, shared by add and update below. See that file's header for
// what an unvalidated `req.body` straight into the subdocument used to cost.

// A saved address's label only carries a free-text customLabel while label === 'other' —
// clear it here whenever label is (re)set to 'home'/'work' so it can't go stale.
const clearCustomLabelUnlessOther = (address) => {
  if (address.label !== 'other') address.customLabel = null;
};

// At most one saved address is ever isDefault:true. Called whenever a write is about to
// make `keepAddressId` the default — every sibling gets unset first, atomically, within
// the same document save (no possible window where two addresses are both default, or
// none is, that a partial failure could leave behind).
const unsetOtherDefaults = (savedAddresses, keepAddressId) => {
  for (const addr of savedAddresses) {
    if (String(addr._id) !== String(keepAddressId)) addr.isDefault = false;
  }
};

export const addAddress = async (userId, addressData) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const input = parseAddressInput(addressData);

  // The very first address a customer saves has nothing to be "default" relative to —
  // make it the default automatically rather than leaving them with no default address.
  const makeDefault = input.isDefault === true || user.savedAddresses.length === 0;

  const resolved = await resolveAddress({}, input);
  user.savedAddresses.push({ ...resolved, isDefault: makeDefault });
  const added = user.savedAddresses[user.savedAddresses.length - 1];
  clearCustomLabelUnlessOther(added);
  if (makeDefault) unsetOtherDefaults(user.savedAddresses, added._id);

  await user.save();
  return user.savedAddresses;
};

export const updateAddress = async (userId, addrId, updates) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const address = user.savedAddresses.id(addrId);
  if (!address) throw new ApiError(404, 'NOT_FOUND', 'Address not found');

  const patch = parseAddressInput(updates, { partial: true });
  const existing = address.toObject();

  // Re-geocode only when the address actually MOVED, and only when the caller didn't send
  // its own fix. The old rule fired whenever a postal key was merely present in the patch,
  // and the app's edit screen posts all of them on every save — so editing the receiver's
  // phone number replaced the pin the customer had dragged with a geocoder's reading of
  // the text line. `postalPartsChanged` compares values, not key presence.
  const moved = postalPartsChanged(existing, patch);
  const resolved = await resolveAddress(existing, patch, {
    geocode: moved && !patch.location,
  });

  Object.assign(address, resolved);
  // Spelled out rather than left to the assign above: an address that moved somewhere the
  // geocoder can't place must end up with NO point, not the previous street's. Clearing the
  // source alongside it keeps the two from disagreeing.
  if ('location' in resolved && resolved.location === undefined) {
    address.location = undefined;
    address.locationSource = 'unknown';
  }

  clearCustomLabelUnlessOther(address);
  if (updates.isDefault === true) unsetOtherDefaults(user.savedAddresses, address._id);

  await user.save();
  return user.savedAddresses;
};

export const setDefaultAddress = async (userId, addrId) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const address = user.savedAddresses.id(addrId);
  if (!address) throw new ApiError(404, 'NOT_FOUND', 'Address not found');

  address.isDefault = true;
  unsetOtherDefaults(user.savedAddresses, address._id);

  await user.save();
  return user.savedAddresses;
};

export const removeAddress = async (userId, addrId) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  const address = user.savedAddresses.id(addrId);
  const wasDefault = address?.isDefault === true;

  user.savedAddresses.pull(addrId);

  // Promoting a replacement default keeps "exactly one default address" true whenever
  // at least one address remains — the checkout/address-selection screens (18/30) always
  // have a sensible pre-selected address rather than silently ending up with none.
  if (wasDefault && user.savedAddresses.length > 0) {
    user.savedAddresses[0].isDefault = true;
  }

  await user.save();
  return user.savedAddresses;
};
