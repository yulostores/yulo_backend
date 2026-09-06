import User from '../models/User.js';
import UserDevice from '../models/UserDevice.js';
import { geocodeAddress } from './geocode.service.js';
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

// A saved address's coordinates are what every downstream distance calculation runs on:
// the delivery fee, the partner's distance pay (services/geo.service.js's computeDropKm),
// the live-tracking ETA, and which partners are even considered for the order. A client
// cannot be relied on to produce them — a typed address has no fix at all, and the mobile
// app was filling the gap with the Bengaluru city centre, which quietly made every one of
// those numbers wrong for every customer outside that one point.
//
// So the server resolves them, with the same geocoder that already turns a restaurant's
// street address into its required 2dsphere point. That service's own file comment warns
// it is not sized for a per-ORDER path; this is a per-ADDRESS path — a handful of calls
// over a customer's lifetime, the same order of magnitude as restaurant onboarding.
//
// A device fix, when the client has one, is better than anything a geocoder can infer
// from a text line, so a supplied coordinate pair always wins and no lookup is made. A
// failed lookup leaves the address without coordinates rather than blocking the save (a
// customer must still be able to save an address the geocoder doesn't recognise) — the
// distance-based features degrade for it, which is honest, where a fabricated city centre
// was not.
const withResolvedCoordinates = async (address) => {
  if (address.location?.coordinates?.length === 2) return address;

  const coordinates = await geocodeAddress(address);
  if (!coordinates) return { ...address, location: undefined };

  return { ...address, location: { type: 'Point', coordinates } };
};

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

  // The very first address a customer saves has nothing to be "default" relative to —
  // make it the default automatically rather than leaving them with no default address.
  const makeDefault = addressData.isDefault === true || user.savedAddresses.length === 0;

  const resolved = await withResolvedCoordinates(addressData);
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

  Object.assign(address, updates);

  // Re-resolve whenever the postal fields changed and the caller didn't send its own fix:
  // an address edited from "12 MG Road" to "12 Residency Road" that kept the old point
  // would send the partner to the previous street.
  const movedFields = ['street', 'city', 'state', 'pincode'];
  if (!updates.location && movedFields.some((f) => f in updates)) {
    const coordinates = await geocodeAddress(address.toObject());
    address.location = coordinates ? { type: 'Point', coordinates } : undefined;
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
