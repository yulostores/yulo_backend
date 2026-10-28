// Shared fixtures for the live customer activity tests (test/live-*.test.js). NOT under test/
// on purpose, so `node --test` doesn't run it as a file. Import it after the in-memory MongoDB
// is up (test-utils/memoryMongo.mjs); every builder writes through the real models.

import mongoose from 'mongoose';

const { default: User } = await import('../models/User.js');
const { default: CustomerSession } = await import('../models/CustomerSession.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { generateTokens } = await import('../services/auth.service.js');
const { now } = await import('../utils/clock.js');

const { ObjectId } = mongoose.Types;

// Unique, valid-looking 10-digit phone numbers per test run.
let phoneSeq = 9000000000;
const nextPhone = () => String(++phoneSeq);

/** A signed-in customer (`role: 'customer'`). */
export const makeCustomer = (overrides = {}) =>
  User.create({ name: 'Aarav Sharma', phone: nextPhone(), role: 'customer', ...overrides });

/** A guest session's user (`role: 'guest'`, no phone). */
export const makeGuest = (overrides = {}) => User.create({ name: 'Guest', role: 'guest', ...overrides });

/**
 * A user row written before the activity preferences existed — inserted raw, so no Mongoose
 * default fills in `shareActivity` / `activityNoticeAt`. Returns `{ _id, role }`.
 */
export const makeLegacyCustomer = async (preferences = { vegModeEnabled: true, preferredLanguage: 'en' }) => {
  const { insertedId } = await User.collection.insertOne({
    name: 'Old Customer',
    phone: nextPhone(),
    role: 'customer',
    isActive: true,
    preferences,
  });
  return { _id: insertedId, role: 'customer' };
};

/** `Authorization` header for a user (anything with `_id` and `role`). */
export const authHeader = (user) => ({
  Authorization: `Bearer ${generateTokens(user._id, user.role).accessToken}`,
});

/**
 * A CustomerSession. Defaults: open (`active`), a fresh restaurant and user id, last activity
 * at a fixed instant so expiry maths is deterministic.
 */
export const makeSession = (overrides = {}) => {
  const at = overrides.lastActivityAt ?? new Date('2026-10-27T10:00:00Z');
  return CustomerSession.create({
    restaurantId: new ObjectId(),
    userId: new ObjectId(),
    displayName: 'Aarav',
    startedAt: at,
    lastActivityAt: at,
    ...overrides,
  });
};

// Where test restaurants sit, and a drop ~1 km away (inside the 10 km delivery radius).
export const RESTAURANT_AT = [77.59, 12.97];
export const NEARBY_DROP = [77.599, 12.97];

/**
 * A public (approved, active) restaurant with an owner and two dishes:
 * `{ restaurant, owner, paneer (₹250), naan (₹40) }`.
 */
export const makeRestaurant = async ({ name = 'Spice Route' } = {}) => {
  const owner = await User.create({ name: 'Owner', email: `owner${nextPhone()}@test.local`, role: 'restaurant_owner' });
  const restaurant = await Restaurant.create({
    ownerId: owner._id,
    name,
    location: { type: 'Point', coordinates: RESTAURANT_AT },
    isActive: true,
    approvalStatus: 'active',
    delivery: { radiusKm: 10 },
  });
  const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  const dish = (dishName, sellingPrice) =>
    MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: dishName, foodType: 'veg', sellingPrice });
  const [paneer, naan] = await Promise.all([dish('Paneer Tikka', 250), dish('Butter Naan', 40)]);
  return { restaurant, owner, paneer, naan };
};

/** A customer with a default delivery address near the test restaurants (can check out). */
export const makeDeliveryCustomer = (overrides = {}) =>
  makeCustomer({
    savedAddresses: [
      {
        street: '22 Lake Road',
        city: 'Bengaluru',
        pincode: '560001',
        location: { type: 'Point', coordinates: NEARBY_DROP },
        locationSource: 'map_pin',
        isDefault: true,
      },
    ],
    ...overrides,
  });

/**
 * A tiny in-memory stand-in for the ioredis calls live activity makes (get, set with EX / NX,
 * del). Expiry follows utils/clock.js, so tests can move time past a key's TTL.
 */
export const createFakeRedis = () => {
  const store = new Map(); // key → { value, expiresAt (ms) | null }
  const live = (k) => {
    const entry = store.get(k);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now().getTime()) {
      store.delete(k);
      return null;
    }
    return entry;
  };
  return {
    status: 'ready',
    store,
    async get(k) {
      return live(k)?.value ?? null;
    },
    async set(k, value, ...args) {
      const upper = args.map((a) => (typeof a === 'string' ? a.toUpperCase() : a));
      if (upper.includes('NX') && live(k)) return null;
      const ex = upper.indexOf('EX');
      store.set(k, { value: String(value), expiresAt: ex >= 0 ? now().getTime() + Number(args[ex + 1]) * 1000 : null });
      return 'OK';
    },
    async del(k) {
      return store.delete(k) ? 1 : 0;
    },
  };
};

export { ObjectId };
