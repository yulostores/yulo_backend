// Shared fixtures for the coupon-partner (seller) tests: valid onboarding data, sellers in any
// state, signed-in headers, and a Cloudinary stand-in for document uploads. Not under test/,
// so `node --test` doesn't run it as a file.

import { mock } from 'node:test';

const { default: Seller } = await import('../models/Seller.js');
const { default: SellerUser } = await import('../models/SellerUser.js');
const { default: CouponCategory } = await import('../models/CouponCategory.js');
const auth = await import('../services/auth.service.js');
const { encryptField } = await import('../utils/fieldEncryption.js');

// Valid values that pass the format checks in utils/kyc.js. The Aadhaar number carries a correct
// Verhoeff check digit; changing its last digit makes it invalid.
export const VALID = Object.freeze({
  gstin: '29ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
  aadhaar: '234123412346',
  aadhaarBadChecksum: '234123412345',
});

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};
export { yearsAgo };

export const businessBody = (categoryId, over = {}) => ({
  businessName: 'Glow Salon',
  categoryId: String(categoryId),
  gstNumber: VALID.gstin,
  address: { line1: '12 MG Road', line2: 'Near the park', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  location: { lat: 12.97, lng: 77.59 },
  businessPhone: '9811111111',
  establishedOn: yearsAgo(5),
  ...over,
});

export const ownerBody = (over = {}) => ({
  name: 'Asha Rao',
  dateOfBirth: yearsAgo(35),
  phone: '9876543210',
  pan: VALID.pan,
  aadhaar: VALID.aadhaar,
  ...over,
});

export const makeCategory = (over = {}) =>
  CouponCategory.create({ key: `cat${Math.random().toString(36).slice(2, 8)}`, name: 'Salon', ...over });

/**
 * A seller whose onboarding is complete (business, owner, PAN/Aadhaar card documents), in the
 * given status, plus its owner login. Returns { seller, owner, headers }.
 */
export const makeCompleteSeller = async ({ status = 'pending', submitted = true, phone = '9876543210', categoryId } = {}) => {
  const category = categoryId ? { _id: categoryId } : await makeCategory();
  const seller = await Seller.create({
    businessName: 'Glow Salon',
    categoryId: category._id,
    gstNumber: null,
    address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
    businessPhone: '9811111111',
    establishedOn: new Date(yearsAgo(5)),
    owner: {
      name: 'Asha Rao',
      dateOfBirth: new Date(yearsAgo(35)),
      phone,
      panEncrypted: encryptField(VALID.pan),
      panLast4: VALID.pan.slice(-4),
      aadhaarLast4: VALID.aadhaar.slice(-4),
    },
    documents: [
      { type: 'pan_card', url: 'https://res.example.invalid/pan', publicId: 'p1', resourceType: 'image', mimeType: 'image/png' },
      { type: 'aadhaar_card', url: 'https://res.example.invalid/aadhaar', publicId: 'a1', resourceType: 'image', mimeType: 'image/png' },
    ],
    status,
    submittedAt: submitted ? new Date() : null,
  });
  const owner = await SellerUser.create({ sellerId: seller._id, name: 'Asha Rao', phone, role: 'owner' });
  return { seller, owner, headers: sellerHeaders(owner) };
};

export const sellerHeaders = (sellerUser) => ({
  authorization: `Bearer ${auth.generateSellerTokens(sellerUser).accessToken}`,
});

/**
 * Replaces Cloudinary's uploader with an in-memory one for the duration of a test. Returns
 * { uploads, destroyed, restore }.
 */
export const mockCloudinary = async ({ failUpload = false } = {}) => {
  const { cloudinary } = await import('../services/upload.service.js');
  const uploads = [];
  const destroyed = [];
  const up = mock.method(cloudinary.uploader, 'upload_stream', (opts, cb) => ({
    end: () => {
      if (failUpload) return cb(new Error('Invalid image file'));
      uploads.push(opts);
      return cb(null, { secure_url: `https://res.example.invalid/${opts.folder}/${opts.public_id}`, public_id: `${opts.folder}/${opts.public_id}` });
    },
  }));
  const del = mock.method(cloudinary.uploader, 'destroy', async (publicId) => {
    destroyed.push(publicId);
    return { result: 'ok' };
  });
  return {
    uploads,
    destroyed,
    restore() {
      up.mock.restore();
      del.mock.restore();
    },
  };
};

/** POSTs a multipart document upload; returns { status, body }. */
export const uploadFile = async (base, path, headers, { type, name = 'card.png', mime = 'image/png', bytes = 'PNGDATA' } = {}) => {
  const form = new FormData();
  if (type !== undefined) form.append('type', type);
  form.append('document', new Blob([Buffer.from(bytes)], { type: mime }), name);
  const res = await fetch(base + path, { method: 'POST', headers, body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

/**
 * Walks every key and value of a seller API response and fails on anything a seller must never
 * receive (§ Business rules — Visibility): a customer's phone number (any of `customerPhones`,
 * anywhere, even inside a longer string), a customer id (the key, or any of `customerIds` as a
 * value), a complimentary coupon (kind: 'complimentary') or any mention of complimentary coupons.
 */
export const assertSellerSafe = (body, { customerPhones = [], customerIds = [], label = 'response' } = {}) => {
  const phones = customerPhones.map(String);
  const ids = customerIds.map(String);
  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const p of phones) if (value.includes(p)) throw new Error(`${label}: customer phone at ${path}`);
      for (const id of ids) if (value.includes(id)) throw new Error(`${label}: customer id at ${path}`);
      if (/complimentary/i.test(value)) throw new Error(`${label}: "complimentary" at ${path}`);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^customerId$|^customerPhone$|complimentary/i.test(key)) throw new Error(`${label}: forbidden key ${path}.${key}`);
      if (key === 'kind' && child === 'complimentary') throw new Error(`${label}: complimentary coupon at ${path}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(typeof body === 'string' ? { text: body } : body, '$');
};
