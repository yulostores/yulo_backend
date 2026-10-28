// Seeds a LOCAL database for walking the live customer activity feature end to end (I1):
//   - two approved restaurants (Spice Route, Tandoor House) with owner logins and a short menu
//   - Aarav (returning customer — 3 delivered orders at Spice Route) and Meera (new customer),
//     both with a delivery address near the restaurants
//   - Finance Settings with cash on delivery switched on
// Guests aren't seeded: the app's "Continue as guest" creates one, which is the real path.
// Customers sign in with SMS_PROVIDER=bypass (any 6-digit code).
//
//   node scripts/seedLiveActivity.js
//
// Refuses anything but a local MongoDB (localhost / 127.0.0.1) and NODE_ENV=production. Safe to
// re-run: users are matched by email / phone and restaurants by name, and nothing is duplicated.

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Category from '../models/Category.js';
import MenuItem from '../models/MenuItem.js';
import Order from '../models/Order.js';
import { hashPassword } from '../services/auth.service.js';
import { createVersion, getActiveSettings, __resetFinanceSettingsCache } from '../services/financeSettings.service.js';

const uri = process.env.MONGODB_URI ?? '';
const host = (() => {
  try {
    return new URL(uri).hostname;
  } catch {
    return '';
  }
})();
if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(host)) {
  console.error('Refusing to seed: MONGODB_URI must point at a local MongoDB (localhost / 127.0.0.1), and NODE_ENV must not be production.');
  process.exit(1);
}

// Bengaluru, ~1 km apart, inside each restaurant's delivery radius.
const AT = { spice: [77.59, 12.97], tandoor: [77.6, 12.975], home: [77.599, 12.97] };
const OWNER_PASSWORD = 'LiveOwner@123';
// Open all day, every day, so testing never depends on the clock.
const ALL_DAY = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => ({
  day,
  isOpen: true,
  openTime: 0,
  closeTime: 2359,
}));

const address = {
  street: '22 Lake Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  location: { type: 'Point', coordinates: AT.home },
  locationSource: 'map_pin',
  isDefault: true,
};

async function upsertUser(match, fields) {
  const existing = await User.findOne(match);
  if (existing) return existing;
  return User.create({ ...match, ...fields });
}

async function restaurantWithMenu(name, ownerEmail, coordinates, dishes) {
  const owner = await upsertUser(
    { email: ownerEmail },
    { name: `${name} Owner`, role: 'restaurant_owner', passwordHash: await hashPassword(OWNER_PASSWORD), isActive: true },
  );
  let restaurant = await Restaurant.findOne({ name });
  if (!restaurant) {
    restaurant = await Restaurant.create({
      ownerId: owner._id,
      name,
      location: { type: 'Point', coordinates },
      isActive: true,
      approvalStatus: 'active',
      delivery: { radiusKm: 10 },
      cuisineTypes: ['North Indian'],
      operatingHours: ALL_DAY,
    });
  } else if (!restaurant.operatingHours?.length) {
    restaurant.operatingHours = ALL_DAY;
    await restaurant.save();
  }
  let category = await Category.findOne({ restaurantId: restaurant._id, name: 'Mains' });
  if (!category) category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
  const items = [];
  for (const [dish, price] of dishes) {
    items.push(
      (await MenuItem.findOne({ restaurantId: restaurant._id, name: dish })) ??
        (await MenuItem.create({ restaurantId: restaurant._id, categoryId: category._id, name: dish, foodType: 'veg', sellingPrice: price, isAvailable: true })),
    );
  }
  return { owner, restaurant, items };
}

await mongoose.connect(uri);
console.log(`✓ Connected to local ${host}`);

// Finance Settings v1, then COD on (so orders can be placed without a gateway).
__resetFinanceSettingsCache();
const settings = await getActiveSettings();
if (!settings.codEnabled) {
  await createVersion({ patch: { codEnabled: true }, note: 'Local live-activity testing: COD on' }, null);
  __resetFinanceSettingsCache();
}
console.log('✓ Finance Settings (COD on)');

const spice = await restaurantWithMenu('Spice Route', 'owner-spice@yulo.local', AT.spice, [
  ['Paneer Tikka', 250],
  ['Butter Naan', 40],
  ['Dal Makhani', 220],
  ['Gulab Jamun', 90],
]);
const tandoor = await restaurantWithMenu('Tandoor House', 'owner-tandoor@yulo.local', AT.tandoor, [
  ['Veg Biryani', 260],
  ['Tandoori Roti', 30],
]);
console.log('✓ Restaurants: Spice Route, Tandoor House');

const aarav = await upsertUser({ phone: '9000000001' }, { name: 'Aarav Sharma', role: 'customer', isActive: true, savedAddresses: [address] });
const meera = await upsertUser({ phone: '9000000002' }, { name: 'Meera Nair', role: 'customer', isActive: true, savedAddresses: [address] });

// Aarav's history at Spice Route: three delivered orders (the "returning" badge).
const past = await Order.countDocuments({ userId: aarav._id, restaurantId: spice.restaurant._id, status: 'delivered' });
for (let i = past; i < 3; i += 1) {
  await Order.collection.insertOne({
    restaurantId: spice.restaurant._id,
    userId: aarav._id,
    type: 'delivery',
    status: 'delivered',
    placedBy: 'customer',
    items: [{ menuItemId: spice.items[0]._id, name: 'Paneer Tikka', price: 250, quantity: 1 }],
    grandTotal: 262,
    createdAt: new Date(Date.now() - (i + 1) * 7 * 24 * 60 * 60 * 1000),
  });
}
console.log('✓ Customers: Aarav (3 past orders at Spice Route), Meera (new)');

console.log(`
Portal logins (password ${OWNER_PASSWORD}):
  owner-spice@yulo.local    Spice Route   ${spice.restaurant._id}
  owner-tandoor@yulo.local  Tandoor House ${tandoor.restaurant._id}
App sign-in (SMS_PROVIDER=bypass, any 6-digit code):
  9000000001  Aarav Sharma (returning)
  9000000002  Meera Nair (new)
  "Continue as guest" for a guest`);

await mongoose.disconnect();
