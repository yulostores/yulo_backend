// What the restaurant owner's write endpoints refuse, from a full portal test: store settings
// (change-aware: legacy values never block an unrelated save), the restaurant profile route
// (address merged, not replaced), categories / sub-categories / tables (no mass assignment,
// no cross-restaurant writes, a deleted table number can be added back), menu items, offers
// (description stored, code rules, readable duplicate message), loyalty and delivery caps.
// In-memory MongoDB; the geocoder's fetch is stubbed.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: Category } = await import('../models/Category.js');
const { default: Table } = await import('../models/Table.js');
const { default: MenuItem } = await import('../models/MenuItem.js');
const { default: Discount } = await import('../models/Discount.js');
const { default: LoyaltyMilestone } = await import('../models/LoyaltyMilestone.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let owner;
let restaurant;
let other; // another owner's restaurant

const realFetch = globalThis.fetch;
before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
  await Promise.all([Table.init(), Discount.init()]);
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('nominatim') || href.includes('geocode')) {
      return new Response(JSON.stringify([{ lat: '18.5', lon: '73.8' }]), { status: 200 });
    }
    return realFetch(url, init);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await srv?.close();
  await mongo?.stop();
});

const makeRestaurant = (ownerId, name) =>
  Restaurant.create({
    ownerId,
    name,
    email: 'hello@spice.test',
    phone: '9876543210',
    address: { street: '12 Main Road', city: 'Pune', state: 'MH', pincode: '411001' },
    location: { type: 'Point', coordinates: [73.8, 18.5] },
    settings: { legalEntityType: 'Partnership', ownerName: 'Owner', panNumber: 'ABCDE1234F' },
    isActive: true,
    approvalStatus: 'active',
  });

beforeEach(async () => {
  await mongo.clear();
  owner = await User.create({ name: 'Owner', email: 'o@test.local', role: 'restaurant_owner' });
  const otherOwner = await User.create({ name: 'Other', email: 'x@test.local', role: 'restaurant_owner' });
  restaurant = await makeRestaurant(owner._id, 'Spice Route');
  other = await makeRestaurant(otherOwner._id, 'Elsewhere');
});

const call = (method, path, body) =>
  srv.request(method, `/api/owner/${restaurant._id}${path}`, {
    headers: { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` },
    body,
  });

describe('store settings: every changed field is checked, untouched legacy values never block', () => {
  test('a legacy legal entity type does not stop a phone correction', async () => {
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'settings.legalEntityType': 'old-llp' } });
    const res = await call('PATCH', '/settings', { phone: '9123456780', settings: { legalEntityType: 'old-llp' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await Restaurant.findById(restaurant._id).lean()).phone, '9123456780');
  });

  test('…but changing it to something off the list is refused', async () => {
    const res = await call('PATCH', '/settings', { settings: { legalEntityType: 'bogus' } });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.fieldErrors['settings.legalEntityType']);
  });

  test('optional fields are now checked when changed: website, year, description, cuisines, dates', async () => {
    for (const [body, path] of [
      [{ website: 'javascript:alert(1)' }, 'website'],
      [{ establishedYear: 3000 }, 'establishedYear'],
      [{ description: 'x'.repeat(501) }, 'description'],
      [{ cuisineTypes: ['y'.repeat(41)] }, 'cuisineTypes'],
      [{ settings: { licenseExpiry: 'not-a-date' } }, 'settings.licenseExpiry'],
    ]) {
      const res = await call('PATCH', '/settings', body);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.details.fieldErrors[path], path);
    }
    assert.equal((await call('PATCH', '/settings', { website: 'www.spice.in' })).status, 200);
  });

  test('a required field cleared is still refused', async () => {
    const res = await call('PATCH', '/settings', { email: '' });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.fieldErrors.email);
  });

  test('delivery money has a ceiling', async () => {
    assert.equal((await call('PATCH', '/settings/delivery', { baseCharge: 1e12 })).status, 400);
    assert.equal((await call('PATCH', '/settings/delivery', { freeThreshold: 1e9 })).status, 400);
    assert.equal((await call('PATCH', '/settings/delivery', { baseCharge: 30, radiusKm: 5 })).status, 200);
  });
});

describe('PATCH /restaurant', () => {
  test('a partial address is merged into the one on file, not swapped for it', async () => {
    const res = await call('PATCH', '/restaurant', { address: { pincode: '411045' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const saved = await Restaurant.findById(restaurant._id).lean();
    assert.deepEqual(saved.address, { street: '12 Main Road', city: 'Pune', state: 'MH', pincode: '411045' });
  });

  test('bad values are refused: PIN code, a one-letter name, non-boolean flags, oversized badges', async () => {
    assert.equal((await call('PATCH', '/restaurant', { address: { pincode: '12' } })).status, 400);
    assert.equal((await call('PATCH', '/restaurant', { name: 'x' })).status, 400);
    assert.equal((await call('PATCH', '/restaurant', { isActive: 'yes' })).status, 400);
    assert.equal((await call('PATCH', '/restaurant', { badges: Array(11).fill('a') })).status, 400);
    const saved = await Restaurant.findById(restaurant._id).lean();
    assert.equal(saved.address.pincode, '411001');
    assert.equal(saved.name, 'Spice Route');
  });

  test('a detail missing elsewhere does not block the map pin', async () => {
    await Restaurant.updateOne({ _id: restaurant._id }, { $unset: { 'address.city': 1 } });
    const res = await call('PATCH', '/restaurant', { location: { type: 'Point', coordinates: [73.85, 18.52] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});

describe('categories, sub-categories and tables', () => {
  test('a category cannot be moved to another restaurant, blanked, or duplicated', async () => {
    const created = await call('POST', '/categories', { name: 'Starters' });
    assert.equal(created.status, 201);
    const id = created.body.data.category._id;
    assert.equal((await call('PATCH', `/categories/${id}`, { restaurantId: String(other._id) })).status, 400);
    assert.equal((await call('PATCH', `/categories/${id}`, { name: '' })).status, 400);
    assert.equal((await call('POST', '/categories', { name: 'starters' })).status, 409);
    assert.equal((await call('POST', '/categories', { name: 'c'.repeat(61) })).status, 400);
    assert.equal(String((await Category.findById(id).lean()).restaurantId), String(restaurant._id));
  });

  test("another restaurant's sub-categories are out of reach", async () => {
    const theirs = await Category.create({ restaurantId: other._id, name: 'Theirs' });
    for (const [method, path, body] of [
      ['GET', `/categories/${theirs._id}/subcategories`],
      ['POST', `/categories/${theirs._id}/subcategories`, { name: 'Sneaky' }],
    ]) {
      assert.equal((await call(method, path, body)).status, 404, `${method} ${path}`);
    }
  });

  test('table updates take only identifier / capacity / isActive, in range', async () => {
    const created = await call('POST', '/tables', { identifier: 'T1' });
    const id = created.body.data.table._id;
    assert.equal((await call('PATCH', `/tables/${id}`, { qrCode: { status: 'void' } })).status, 400);
    assert.equal((await call('PATCH', `/tables/${id}`, { capacity: -4 })).status, 400);
    assert.equal((await call('POST', '/tables', { identifier: 'q'.repeat(31) })).status, 400);
    assert.equal((await call('PATCH', `/tables/${id}`, { capacity: 4 })).status, 200);
    assert.equal((await Table.findById(id).lean()).qrCode.status, 'active');
  });

  test('a deleted table number can be added again (the old table comes back)', async () => {
    const created = await call('POST', '/tables', { identifier: '7' });
    const id = created.body.data.table._id;
    assert.equal((await call('DELETE', `/tables/${id}`)).status, 200);
    const again = await call('POST', '/tables', { identifier: '7' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.data.table._id, id);
    assert.equal(again.body.data.table.isActive, true);
  });

  test('a live duplicate table number names the table, not restaurantId', async () => {
    await call('POST', '/tables', { identifier: '9' });
    const dup = await call('POST', '/tables', { identifier: '9' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.message, 'A table with this number already exists');
  });
});

describe('menu items', () => {
  test('price ceiling, prep time range, readable model errors on edit', async () => {
    const category = await Category.create({ restaurantId: restaurant._id, name: 'Mains' });
    const base = { name: 'Dal', categoryId: String(category._id), foodType: 'veg' };
    assert.equal((await call('POST', '/menu-items', { ...base, sellingPrice: 1e15 })).status, 400);
    assert.equal((await call('POST', '/menu-items', { ...base, sellingPrice: 100, prepTime: -3 })).status, 400);
    const item = await MenuItem.create({ ...base, restaurantId: restaurant._id, sellingPrice: 100, prepTime: 0 });
    // A legacy prep time of 0 does not block a price edit…
    assert.equal((await call('PATCH', `/menu-items/${item._id}`, { sellingPrice: 120, prepTime: 0 })).status, 200);
    const longName = await call('PATCH', `/menu-items/${item._id}`, { name: 'n'.repeat(150) });
    assert.equal(longName.status, 400);
    assert.equal(longName.body.message, 'Name must be at most 100 characters');
    assert.equal((await call('PATCH', `/menu-items/${item._id}`, { foodType: 'meat' })).status, 400);
    assert.equal((await call('PATCH', `/menu-items/${item._id}/ingredients`, { ingredients: ['i'.repeat(61)] })).status, 400);
  });
});

describe('offers', () => {
  const offer = (extra) => ({
    offerName: 'Treat',
    type: 'percentage',
    percentage: 10,
    applicableTo: 'dine_in',
    startDate: '2026-11-10',
    endDate: '2026-11-20',
    ...extra,
  });

  test('the description the owner writes is stored', async () => {
    const res = await call('POST', '/discounts', offer({ code: 'SWEET', description: 'Free dessert over ₹300' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await Discount.findById(res.body.data.discount._id).lean()).description, 'Free dessert over ₹300');
  });

  test('code characters, amounts and name length are limited; a duplicate code says so', async () => {
    assert.equal((await call('POST', '/discounts', offer({ code: 'bad code !!' }))).status, 400);
    assert.equal((await call('POST', '/discounts', offer({ code: 'BIG', type: 'flat_amount', percentage: undefined, flatAmount: 1e12 }))).status, 400);
    assert.equal((await call('POST', '/discounts', offer({ code: 'MOV', minimumOrderValue: 1e12 }))).status, 400);
    assert.equal((await call('POST', '/discounts', offer({ code: 'LONG', offerName: 'n'.repeat(101) }))).status, 400);
    assert.equal((await call('POST', '/discounts', offer({ code: 'ONCE' }))).status, 201);
    const dup = await call('POST', '/discounts', offer({ code: 'ONCE' }));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.message, 'This coupon code is already in use');
  });
});

describe('loyalty', () => {
  test('program values are checked and milestones cannot be moved to another restaurant', async () => {
    assert.equal((await call('PATCH', '/loyalty', { pointsPerRupee: -5 })).status, 400);
    const created = await call('POST', '/loyalty/milestones', { offerName: 'Tenth visit', rewardType: 'percentage', rewardValue: 10 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.milestone._id;
    assert.equal((await call('PATCH', `/loyalty/milestones/${id}`, { restaurantId: String(other._id) })).status, 400);
    assert.equal(String((await LoyaltyMilestone.findById(id).lean()).restaurantId), String(restaurant._id));
  });
});

describe('owner profile (PATCH /users/me)', () => {
  const me = (body) =>
    srv.request('PATCH', '/api/users/me', {
      headers: { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` },
      body,
    });

  test('a malformed phone or an over-long name is refused', async () => {
    assert.equal((await me({ phone: '12' })).status, 400);
    assert.equal((await me({ name: 'N'.repeat(300) })).status, 400);
    const saved = await User.findById(owner._id).lean();
    assert.equal(saved.phone, undefined);
    assert.equal(saved.name, 'Owner');
  });

  test('a valid phone saves, and an empty one removes it', async () => {
    assert.equal((await me({ phone: '9123456780' })).status, 200);
    assert.equal((await User.findById(owner._id).lean()).phone, '9123456780');
    assert.equal((await me({ phone: '' })).status, 200);
    assert.equal((await User.findById(owner._id).lean()).phone, undefined);
  });
});

describe('image uploads', () => {
  test('a non-image renamed .png is refused before it reaches Cloudinary', async () => {
    const send = async (bytes) => {
      const form = new FormData();
      form.append('logo', new Blob([bytes], { type: 'image/png' }), 'logo.png');
      const res = await fetch(`${srv.base}/api/owner/${restaurant._id}/settings`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${generateTokens(owner._id, 'restaurant_owner').accessToken}` },
        body: form,
      });
      return { status: res.status, body: await res.json() };
    };
    const fake = await send(Buffer.from('not an image at all'));
    assert.equal(fake.status, 400, JSON.stringify(fake.body));
    assert.equal(fake.body.code, 'INVALID_FILE_TYPE');
  });
});

describe('saved business and licence details are locked to the owner', () => {
  test('a saved PAN cannot be changed; re-sending it, or a saved date as the same day, is fine', async () => {
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { 'settings.licenseExpiry': new Date('2027-03-30T18:30:00Z') } });
    const changed = await call('PATCH', '/settings', { settings: { panNumber: 'ZZZZZ9999Z' } });
    assert.equal(changed.status, 400);
    assert.equal(changed.body.code, 'FIELD_LOCKED');
    assert.equal((await Restaurant.findById(restaurant._id).lean()).settings.panNumber, 'ABCDE1234F');

    const same = await call('PATCH', '/settings', {
      phone: '9123456789',
      settings: { panNumber: 'ABCDE1234F', legalEntityType: 'Partnership', licenseExpiry: '2027-03-31' },
    });
    assert.equal(same.status, 200, JSON.stringify(same.body));
  });

  test('a licence field never saved can still be filled in', async () => {
    const res = await call('PATCH', '/settings', { settings: { healthPermitId: 'FSSAI-123' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});
