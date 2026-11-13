import { z } from 'zod';
import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import { encryptField } from '../utils/fieldEncryption.js';
import { ApiError } from '../utils/ApiError.js';
import { normalizeIndianPhone } from '../utils/phone.js';
import { ageOn } from '../utils/couponCode.js';
import {
  isValidPan,
  normalizePan,
  isValidGstin,
  normalizeGstin,
  isValidAadhaar,
  normalizeAadhaar,
  maskPan,
  maskAadhaar,
} from '../utils/kyc.js';
import { GENDERS, SELLER_DOCUMENT_TYPES } from '../config/coupon.config.js';

// A coupon partner's onboarding: the form an owner fills in before a super admin reviews the
// business (requirements § 4 — business, owner and employee information, plus documents).
//
// Who may change what, by seller status:
//   pending / rejected   the owner edits every section and resubmits
//   active / suspended   only the business's contact details (phone, address, map pin); the
//                        rest was what the admin approved, so changing it is a support case.
//                        The team is managed from the portal's Team screen from then on (CB8).
//
// Identity numbers: PAN is stored encrypted (utils/fieldEncryption.js) with its last 4 in clear.
// Aadhaar: only the last 4 digits are kept, plus the uploaded card — the full number is checked
// and then discarded (§ Business rules — Aadhaar), so there is nothing to leak.

const EDITABLE_STATUSES = ['pending', 'rejected'];
// After approval: the contact details a business may move or change on its own.
export const CONTACT_FIELDS = ['businessPhone', 'address', 'location'];
const MIN_OWNER_AGE = 18;
const MIN_EMPLOYEE_AGE = 14;

// Documents an application must carry before it can be submitted. GST certificate only when a
// GST number was given.
const REQUIRED_DOCUMENTS = ['pan_card', 'aadhaar_card'];

// ── Shared field rules ────────────────────────────────────────────────────────

export const phoneField = z.preprocess(
  (v) => normalizeIndianPhone(v) ?? v,
  z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const pastDate = (label) =>
  z.coerce.date({ error: `${label} must be a date` }).refine((d) => d.getTime() <= Date.now(), `${label} cannot be in the future`);
const ageAtLeast = (years, message) =>
  pastDate('Date of birth').refine((d) => (ageOn(d) ?? -1) >= years, message).refine((d) => (ageOn(d) ?? 0) <= 110, 'Check the date of birth');

const addressSchema = z
  .object({
    line1: z.string().trim().min(3, 'Enter the shop address').max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(2, 'Enter the city').max(80),
    state: z.string().trim().min(2, 'Enter the state').max(80),
    pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a 6-digit pincode'),
  })
  .strict();
const locationSchema = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

// ── Views ─────────────────────────────────────────────────────────────────────

export const toLocationView = (location) =>
  location?.coordinates?.length === 2 ? { lng: location.coordinates[0], lat: location.coordinates[1] } : null;

// Documents without their storage URL: files are read back only through the API
// (services/restaurantDocument.service.js explains why).
export const toDocumentView = (d) => ({
  _id: d._id,
  type: d.type,
  name: d.name ?? null,
  mimeType: d.mimeType ?? null,
  status: d.status,
  uploadedAt: d.uploadedAt,
});

export const toTeamMemberView = (u) => ({
  _id: u._id,
  name: u.name,
  phone: u.phone,
  role: u.role,
  dateOfBirth: u.dateOfBirth ?? null,
  gender: u.gender ?? null,
  experienceYears: u.experienceYears ?? null,
  isActive: Boolean(u.isActive),
});

/** What is still missing before the application can be submitted (empty when complete). */
export const missingSections = (seller) => {
  const missing = [];
  const b = seller;
  if (!b.businessName || !b.categoryId || !b.address?.line1 || !b.address?.city || !b.address?.state || !b.address?.pincode || !b.businessPhone || !b.establishedOn) {
    missing.push('business');
  }
  const o = seller.owner ?? {};
  if (!o.name || !o.dateOfBirth || !o.panLast4 || !o.aadhaarLast4 || !o.phone) missing.push('owner');
  const types = new Set((seller.documents ?? []).map((d) => d.type));
  const requiredDocs = [...REQUIRED_DOCUMENTS, ...(seller.gstNumber ? ['gst_certificate'] : [])];
  for (const type of requiredDocs) if (!types.has(type)) missing.push(`document:${type}`);
  return missing;
};

export const isEditable = (seller) => EDITABLE_STATUSES.includes(seller.status);

/** The whole onboarding form as the owner sees it — identity numbers masked. */
export const onboardingView = async (sellerId) => {
  const seller = await Seller.findById(sellerId).lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  const [category, team] = await Promise.all([
    CouponCategory.findById(seller.categoryId).select('key name').lean(),
    SellerUser.find({ sellerId, role: { $ne: 'owner' }, removedAt: null }).sort({ createdAt: 1 }).lean(),
  ]);
  const editable = isEditable(seller);
  return {
    status: seller.status,
    submittedAt: seller.submittedAt,
    rejectionReason: seller.status === 'rejected' ? seller.rejectionReason : null,
    editable,
    // What the owner may still change once approved; everything in the form while editable.
    editableBusinessFields: editable ? ['businessName', 'categoryId', 'gstNumber', 'establishedOn', ...CONTACT_FIELDS] : CONTACT_FIELDS,
    business: {
      businessName: seller.businessName,
      categoryId: seller.categoryId,
      category: category ? { _id: category._id, key: category.key, name: category.name } : null,
      gstNumber: seller.gstNumber ?? null,
      address: seller.address ?? null,
      location: toLocationView(seller.location),
      businessPhone: seller.businessPhone ?? null,
      establishedOn: seller.establishedOn ?? null,
    },
    owner: {
      name: seller.owner?.name ?? null,
      dateOfBirth: seller.owner?.dateOfBirth ?? null,
      phone: seller.owner?.phone ?? null,
      panMasked: maskPan(seller.owner?.panLast4),
      aadhaarMasked: maskAadhaar(seller.owner?.aadhaarLast4),
    },
    employees: team.map(toTeamMemberView),
    documents: (seller.documents ?? []).map(toDocumentView),
    missing: missingSections(seller),
  };
};

const loadSeller = async (sellerId) => {
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  return seller;
};

const lockedError = (fields) =>
  new ApiError(409, 'ONBOARDING_LOCKED', 'These details were approved and can only be changed by Yulo support', {
    lockedFields: fields,
  });

const parseOr400 = (schema, body, message = 'Invalid input') => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

// ── Business ──────────────────────────────────────────────────────────────────

const businessSchema = z
  .object({
    businessName: z.string().trim().min(2, 'Enter the business name').max(120),
    categoryId: objectId,
    gstNumber: z
      .string()
      .nullish()
      .transform((v) => (v ? normalizeGstin(v) : null))
      .refine((v) => v === null || isValidGstin(v), 'Enter a valid 15-character GSTIN'),
    address: addressSchema,
    location: locationSchema.nullish(),
    businessPhone: phoneField,
    establishedOn: pastDate('Establishment date'),
  })
  .strict();

// After approval only the contact fields may be sent, all optional.
export const contactSchema = z
  .object({ businessPhone: phoneField.optional(), address: addressSchema.optional(), location: locationSchema.nullish() })
  .strict();

export const applyLocation = (seller, location) => {
  if (location === undefined) return;
  seller.location = location ? { type: 'Point', coordinates: [location.lng, location.lat] } : undefined;
};

export const saveBusiness = async (sellerId, body) => {
  const seller = await loadSeller(sellerId);

  if (!isEditable(seller)) {
    const sent = Object.keys(body ?? {});
    const locked = sent.filter((k) => !CONTACT_FIELDS.includes(k));
    if (locked.length) throw lockedError(locked);
    const data = parseOr400(contactSchema, body, 'Invalid business details');
    if (data.businessPhone !== undefined) seller.businessPhone = data.businessPhone;
    if (data.address !== undefined) seller.address = data.address;
    applyLocation(seller, data.location);
    await seller.save();
    return onboardingView(sellerId);
  }

  const data = parseOr400(businessSchema, body, 'Invalid business details');
  if (!(await CouponCategory.exists({ _id: data.categoryId }))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a business category from the list', {
      fieldErrors: { categoryId: ['Unknown category'] },
    });
  }
  Object.assign(seller, {
    businessName: data.businessName,
    categoryId: data.categoryId,
    gstNumber: data.gstNumber,
    address: data.address,
    businessPhone: data.businessPhone,
    establishedOn: data.establishedOn,
  });
  applyLocation(seller, data.location);
  await seller.save();
  return onboardingView(sellerId);
};

// ── Owner ─────────────────────────────────────────────────────────────────────

// PAN and Aadhaar may be left out on a later save: the masked values come back to the form, so
// the owner isn't made to retype them to change their name. The first save needs both.
const ownerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the owner name').max(100),
    dateOfBirth: ageAtLeast(MIN_OWNER_AGE, `The owner must be at least ${MIN_OWNER_AGE}`),
    phone: phoneField,
    pan: z
      .string()
      .transform(normalizePan)
      .refine(isValidPan, 'Enter a valid PAN, e.g. ABCDE1234F')
      .optional(),
    aadhaar: z
      .string()
      .transform(normalizeAadhaar)
      .refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number')
      .optional(),
  })
  .strict();

export const saveOwner = async (sellerId, body) => {
  const seller = await loadSeller(sellerId);
  if (!isEditable(seller)) throw lockedError(Object.keys(body ?? {}));
  const data = parseOr400(ownerSchema, body, 'Invalid owner details');

  const fieldErrors = {};
  if (!data.pan && !seller.owner?.panLast4) fieldErrors.pan = ['Enter the owner PAN'];
  if (!data.aadhaar && !seller.owner?.aadhaarLast4) fieldErrors.aadhaar = ['Enter the owner Aadhaar number'];
  if (Object.keys(fieldErrors).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid owner details', { fieldErrors });

  seller.set('owner.name', data.name);
  seller.set('owner.dateOfBirth', data.dateOfBirth);
  seller.set('owner.phone', data.phone);
  if (data.pan) {
    seller.set('owner.panEncrypted', encryptField(data.pan));
    seller.set('owner.panLast4', data.pan.slice(-4));
  }
  if (data.aadhaar) {
    // Checked, then only its last 4 kept. aadhaarEncrypted stays empty by design.
    seller.set('owner.aadhaarLast4', data.aadhaar.slice(-4));
    seller.set('owner.aadhaarEncrypted', null);
  }
  await seller.save();
  // The owner's login shows the same name.
  await SellerUser.updateMany({ sellerId, role: 'owner', removedAt: null }, { $set: { name: data.name } });
  return onboardingView(sellerId);
};

// ── Employees ─────────────────────────────────────────────────────────────────

const employeeSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the name').max(100),
    phone: phoneField,
    dateOfBirth: ageAtLeast(MIN_EMPLOYEE_AGE, `Must be at least ${MIN_EMPLOYEE_AGE}`).nullish(),
    gender: z.enum(GENDERS).nullish(),
    experienceYears: z.number().min(0).max(80).nullish(),
    // One owner per business: the owner is whoever signed up. Co-owners join as managers.
    role: z.enum(['manager', 'employee'], { error: 'Role must be manager or employee' }),
  })
  .strict();
const employeesSchema = z.object({ employees: z.array(employeeSchema).max(100) }).strict();

/**
 * Replaces the team list (everyone but the owner). Rows are matched by phone: a known phone is
 * updated, a new one is added, and anyone missing from the list is removed (and signed out).
 * New and updated rows stay inactive until the seller is approved.
 */
export const saveEmployees = async (sellerId, body) => {
  const seller = await loadSeller(sellerId);
  if (!isEditable(seller)) throw lockedError(['employees']);
  const { employees } = parseOr400(employeesSchema, body, 'Invalid employee details');

  const phones = employees.map((e) => e.phone);
  const dupes = phones.filter((p, i) => phones.indexOf(p) !== i);
  if (dupes.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Each person needs their own mobile number', { duplicatePhones: [...new Set(dupes)] });
  }
  const owner = await SellerUser.findOne({ sellerId, role: 'owner', removedAt: null }).lean();
  if (owner && phones.includes(owner.phone)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The owner is already on the team — use a different number', {
      duplicatePhones: [owner.phone],
    });
  }

  const existing = await SellerUser.find({ sellerId, role: { $ne: 'owner' }, removedAt: null });
  const byPhone = new Map(existing.map((u) => [u.phone, u]));
  const now = new Date();

  for (const e of employees) {
    const fields = {
      name: e.name,
      dateOfBirth: e.dateOfBirth ?? null,
      gender: e.gender ?? null,
      experienceYears: e.experienceYears ?? null,
      role: e.role,
    };
    const row = byPhone.get(e.phone);
    if (row) {
      const roleChanged = row.role !== e.role;
      row.set(fields);
      if (roleChanged) row.sessionVersion = (row.sessionVersion ?? 0) + 1;
      await row.save();
      byPhone.delete(e.phone);
    } else {
      await SellerUser.create({ sellerId, phone: e.phone, ...fields, isActive: false });
    }
  }
  // Whoever is left was taken off the list.
  for (const row of byPhone.values()) {
    row.set({ isActive: false, removedAt: now, sessionVersion: (row.sessionVersion ?? 0) + 1 });
    await row.save();
  }
  return onboardingView(sellerId);
};

// ── Documents ─────────────────────────────────────────────────────────────────

export const assertDocumentType = (type) => {
  if (!SELLER_DOCUMENT_TYPES.includes(type)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `type must be one of: ${SELLER_DOCUMENT_TYPES.join(', ')}`);
  }
};

export const assertDocumentsEditable = (seller) => {
  if (!isEditable(seller)) throw lockedError(['documents']);
};

// ── Submit ────────────────────────────────────────────────────────────────────

/**
 * Sends the application for review. Refused with the list of what is missing when incomplete.
 * A rejected application returns to `pending`; resubmitting a pending one just updates the time.
 */
export const submit = async (sellerId) => {
  const seller = await loadSeller(sellerId);
  if (!isEditable(seller)) {
    throw new ApiError(409, 'INVALID_STATE', 'This business has already been reviewed', { status: seller.status });
  }
  const missing = missingSections(seller);
  if (missing.length) {
    throw new ApiError(422, 'ONBOARDING_INCOMPLETE', 'Some details are still missing', { missing });
  }
  const updated = await Seller.findOneAndUpdate(
    { _id: sellerId, status: { $in: EDITABLE_STATUSES } },
    { $set: { status: 'pending', submittedAt: new Date(), rejectionReason: null } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'INVALID_STATE', 'This business has already been reviewed');
  return onboardingView(sellerId);
};

export const statusView = async (sellerId) => {
  const seller = await Seller.findById(sellerId).select('status submittedAt reviewedAt rejectionReason').lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  return {
    status: seller.status,
    submittedAt: seller.submittedAt,
    reviewedAt: seller.reviewedAt,
    rejectionReason: seller.status === 'rejected' ? seller.rejectionReason : null,
  };
};
