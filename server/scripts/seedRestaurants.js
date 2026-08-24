import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import Category from '../models/Category.js';
import MenuItem from '../models/MenuItem.js';
import Discount from '../models/Discount.js';
import { hashPassword } from '../services/auth.service.js';

// Where the seeded storefronts are planted. Defaults to Bangalore city centre,
// which is the same fallback coordinate the customer app itself uses
// (Customer_Portal_Client/src/hooks/useSearch.js, CustomerAuthContext.jsx)
// whenever it has NO real GPS fix — an emulator, or an address typed by hand.
//
// A real handset does have a fix, and the Home feed only looks within ~10km of
// it, so a phone anywhere other than Bangalore sees an empty feed against the
// defaults. Override them to seed near wherever the test device actually is:
//
//   SEED_LAT=22.2536 SEED_LNG=84.9010 SEED_CITY=Rourkela SEED_STATE=Odisha \
//     SEED_PINCODE=769008 node scripts/seedRestaurants.js
const CENTER = {
  lat: Number(process.env.SEED_LAT ?? 12.9716),
  lng: Number(process.env.SEED_LNG ?? 77.5946),
};

const PLACE = {
  city: process.env.SEED_CITY ?? 'Bangalore',
  state: process.env.SEED_STATE ?? 'Karnataka',
  pincode: process.env.SEED_PINCODE ?? '560001',
};

if (!Number.isFinite(CENTER.lat) || !Number.isFinite(CENTER.lng)) {
  console.error('SEED_LAT / SEED_LNG must be numbers. Got:', process.env.SEED_LAT, process.env.SEED_LNG);
  process.exit(1);
}

// Small offsets (~0.5-3km) so every restaurant lands inside the default 5km feed radius.
const jitter = (n) => Math.round((Math.random() - 0.5) * n * 100000) / 100000;

const img = (seed, w = 800, h = 600) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

const OPERATING_HOURS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
  (day) => ({ day, isOpen: true, openTime: 540, closeTime: 1380 }) // 9:00 AM - 11:00 PM
);

const RESTAURANTS = [
  {
    name: 'Biryani Junction',
    description: 'Slow-cooked dum biryanis and Hyderabadi classics.',
    cuisineTypes: ['Biryani', 'Hyderabadi', 'North Indian'],
    isPureVeg: false,
    vegFleetAvailable: true,
    categories: [
      {
        name: 'Biryanis',
        items: [
          { name: 'Chicken Dum Biryani', foodType: 'non_veg', sellingPrice: 249, discountedPrice: 219, badges: ['bestseller'] },
          { name: 'Mutton Biryani', foodType: 'non_veg', sellingPrice: 329 },
          { name: 'Veg Hyderabadi Biryani', foodType: 'veg', sellingPrice: 199 },
          { name: 'Egg Biryani', foodType: 'egg', sellingPrice: 179 },
        ],
      },
      {
        name: 'Starters',
        items: [
          { name: 'Chicken 65', foodType: 'non_veg', sellingPrice: 189 },
          { name: 'Paneer Tikka', foodType: 'veg', sellingPrice: 179 },
        ],
      },
    ],
  },
  {
    name: 'Pizza Republic',
    description: 'Wood-fired pizzas and Italian-American comfort food.',
    cuisineTypes: ['Pizza', 'Italian', 'Fast Food'],
    isPureVeg: false,
    vegFleetAvailable: false,
    categories: [
      {
        name: 'Pizzas',
        items: [
          { name: 'Margherita Pizza', foodType: 'veg', sellingPrice: 249, discountedPrice: 199, badges: ['bestseller'] },
          { name: 'Farmhouse Pizza', foodType: 'veg', sellingPrice: 299 },
          { name: 'Chicken Pepperoni Pizza', foodType: 'non_veg', sellingPrice: 349 },
          { name: 'BBQ Chicken Pizza', foodType: 'non_veg', sellingPrice: 379 },
        ],
      },
      {
        name: 'Sides',
        items: [
          { name: 'Garlic Bread', foodType: 'veg', sellingPrice: 129 },
          { name: 'Chicken Wings', foodType: 'non_veg', sellingPrice: 219 },
        ],
      },
    ],
  },
  {
    name: 'Dosa Deck',
    description: 'South Indian breakfast, dosas and filter coffee all day.',
    cuisineTypes: ['South Indian', 'Dosa', 'Breakfast'],
    isPureVeg: true,
    vegFleetAvailable: true,
    categories: [
      {
        name: 'Dosas',
        items: [
          { name: 'Masala Dosa', foodType: 'veg', sellingPrice: 99, discountedPrice: 89, badges: ['bestseller'] },
          { name: 'Mysore Masala Dosa', foodType: 'veg', sellingPrice: 119 },
          { name: 'Rava Dosa', foodType: 'veg', sellingPrice: 109 },
          { name: 'Onion Uttapam', foodType: 'veg', sellingPrice: 109 },
        ],
      },
      {
        name: 'Beverages',
        items: [
          { name: 'Filter Coffee', foodType: 'veg', sellingPrice: 39 },
          { name: 'Fresh Lime Soda', foodType: 'veg', sellingPrice: 59 },
        ],
      },
    ],
  },
  {
    name: 'Burger Barn',
    description: 'Juicy grilled burgers, fries and shakes.',
    cuisineTypes: ['Burgers', 'American', 'Fast Food'],
    isPureVeg: false,
    vegFleetAvailable: false,
    categories: [
      {
        name: 'Burgers',
        items: [
          { name: 'Classic Chicken Burger', foodType: 'non_veg', sellingPrice: 159, badges: ['bestseller'] },
          { name: 'Double Beef Patty Burger', foodType: 'non_veg', sellingPrice: 219 },
          { name: 'Veg Crunch Burger', foodType: 'veg', sellingPrice: 129, discountedPrice: 109 },
        ],
      },
      {
        name: 'Sides & Shakes',
        items: [
          { name: 'Peri Peri Fries', foodType: 'veg', sellingPrice: 99 },
          { name: 'Chocolate Shake', foodType: 'veg', sellingPrice: 149 },
        ],
      },
    ],
  },
  {
    name: 'Punjabi Tadka',
    description: 'Rich North Indian curries, tandoori and fresh naan.',
    cuisineTypes: ['North Indian', 'Punjabi', 'Tandoor'],
    isPureVeg: false,
    vegFleetAvailable: true,
    categories: [
      {
        name: 'Main Course',
        items: [
          { name: 'Butter Chicken', foodType: 'non_veg', sellingPrice: 289, vegVariantName: 'Paneer Butter Masala', badges: ['bestseller'] },
          { name: 'Paneer Butter Masala', foodType: 'veg', sellingPrice: 249 },
          { name: 'Dal Makhani', foodType: 'veg', sellingPrice: 189 },
          { name: 'Rogan Josh', foodType: 'non_veg', sellingPrice: 319 },
        ],
      },
      {
        name: 'Breads',
        items: [
          { name: 'Butter Naan', foodType: 'veg', sellingPrice: 49 },
          { name: 'Garlic Naan', foodType: 'veg', sellingPrice: 59 },
        ],
      },
    ],
  },
  {
    name: 'Sandwich Stop',
    description: 'Toasted sandwiches, wraps and quick bites.',
    cuisineTypes: ['Sandwich', 'Cafe', 'Fast Food'],
    isPureVeg: true,
    vegFleetAvailable: true,
    categories: [
      {
        name: 'Sandwiches',
        items: [
          { name: 'Veg Grilled Sandwich', foodType: 'veg', sellingPrice: 89, discountedPrice: 79, badges: ['bestseller'] },
          { name: 'Paneer Tikka Sandwich', foodType: 'veg', sellingPrice: 119 },
          { name: 'Corn & Cheese Sandwich', foodType: 'veg', sellingPrice: 99 },
        ],
      },
    ],
  },
];

await mongoose.connect(process.env.MONGODB_URI);
console.log('Connected to MongoDB');

let owner = await User.findOne({ email: 'seed-owner@yulostores.test' });
if (!owner) {
  owner = await User.create({
    name: 'Seed Restaurant Owner',
    email: 'seed-owner@yulostores.test',
    passwordHash: await hashPassword('SeedOwner123!'),
    role: 'restaurant_owner',
    isActive: true,
  });
  console.log(`Created seed owner user: ${owner.email}`);
} else {
  console.log(`Reusing existing seed owner user: ${owner.email}`);
}

const createdRestaurants = [];

for (const spec of RESTAURANTS) {
  const existing = await Restaurant.findOne({ name: spec.name, ownerId: owner._id });
  if (existing) {
    console.log(`Skipping "${spec.name}" — already seeded`);
    createdRestaurants.push(existing);
    continue;
  }

  const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const restaurant = await Restaurant.create({
    ownerId: owner._id,
    name: spec.name,
    description: spec.description,
    category: spec.cuisineTypes[0],
    cuisineTypes: spec.cuisineTypes,
    coverImage: img(`${slug}-cover`, 1200, 800),
    logo: img(`${slug}-logo`, 300, 300),
    bannerImage: img(`${slug}-banner`, 1200, 400),
    address: {
      street: `${Math.floor(Math.random() * 200) + 1} MG Road`,
      city: PLACE.city,
      state: PLACE.state,
      pincode: PLACE.pincode,
    },
    location: {
      type: 'Point',
      coordinates: [CENTER.lng + jitter(0.03), CENTER.lat + jitter(0.03)],
    },
    operatingHours: OPERATING_HOURS,
    delivery: { radiusKm: 8, baseCharge: 25, freeThreshold: 399, estimatedMinutes: 35 },
    isActive: true,
    isVerified: true,
    isPureVeg: spec.isPureVeg,
    vegFleetAvailable: spec.vegFleetAvailable,
    badges: spec.cuisineTypes.includes('Biryani') || spec.cuisineTypes.includes('North Indian') ? ['great_offers'] : [],
    avgRating: Math.round((3.8 + Math.random() * 1.2) * 10) / 10,
    totalRatings: Math.floor(Math.random() * 400) + 20,
    approvalStatus: 'active',
    plan: 'standard',
  });

  console.log(`Created restaurant: ${restaurant.name} (${restaurant._id})`);
  createdRestaurants.push(restaurant);

  // First pass: create every item so name -> _id is known before wiring vegVariantId links.
  const itemsByName = new Map();

  for (const [catIndex, catSpec] of spec.categories.entries()) {
    const category = await Category.create({
      restaurantId: restaurant._id,
      name: catSpec.name,
      displayOrder: catIndex,
    });

    for (const itemSpec of catSpec.items) {
      const itemSlug = itemSpec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const item = await MenuItem.create({
        restaurantId: restaurant._id,
        categoryId: category._id,
        name: itemSpec.name,
        description: `${itemSpec.name} from ${restaurant.name}.`,
        image: img(itemSlug),
        prepTime: Math.floor(Math.random() * 20) + 10,
        foodType: itemSpec.foodType,
        sellingPrice: itemSpec.sellingPrice,
        discountedPrice: itemSpec.discountedPrice ?? null,
        isAvailable: true,
        badges: itemSpec.badges ?? [],
      });
      itemsByName.set(itemSpec.name, item);
    }
  }

  // Second pass: link each non-veg item to its declared veg substitute, if any.
  for (const catSpec of spec.categories) {
    for (const itemSpec of catSpec.items) {
      if (!itemSpec.vegVariantName) continue;
      const variant = itemsByName.get(itemSpec.vegVariantName);
      if (!variant) continue;
      await MenuItem.updateOne(
        { _id: itemsByName.get(itemSpec.name)._id },
        { $set: { vegVariantId: variant._id } }
      );
    }
  }
}

// One featured discount so the Home feed banner has something to show.
const bannerRestaurant = createdRestaurants[0];
if (bannerRestaurant) {
  const existingDiscount = await Discount.findOne({
    restaurantId: bannerRestaurant._id,
    isFeatured: true,
  });
  if (!existingDiscount) {
    await Discount.create({
      restaurantId: bannerRestaurant._id,
      type: 'percentage',
      offerName: '20% OFF on your first order',
      code: 'WELCOME20',
      percentage: 20,
      minimumOrderValue: 199,
      applicableTo: 'both',
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      status: 'active',
      isFeatured: true,
    });
    console.log(`Created featured discount on ${bannerRestaurant.name}`);
  }
}

console.log(`\nDone. Seeded ${createdRestaurants.length} restaurants near ${PLACE.city} (${CENTER.lat}, ${CENTER.lng}).`);
await mongoose.disconnect();
