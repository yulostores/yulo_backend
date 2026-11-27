import { z } from 'zod';
import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { sellerSubscriptions } from './sellerSubscription.service.js';
import { contactSchema, applyLocation, toLocationView, CONTACT_FIELDS } from './sellerOnboarding.service.js';
import { maskPan, maskAadhaar } from '../utils/kyc.js';
import { ApiError } from '../utils/ApiError.js';

// The seller's partner agreement and business profile (§ CB8).
//
// Agreement: a category's own (CouponCategory.agreement) when the super admin has published one,
// else the general one in CouponSettings (agreementVersion / agreementText — 0 means none
// published). The owner accepts a specific version; the acceptance (scope, version, time, user,
// IP) is kept on Seller.agreement. Publishing a new version makes the old acceptance out of date.
//
// Profile: what the business looks like to Yulo, identity numbers masked. After approval only the
// contact fields (phone, address, map pin) can change here; anything else goes through Yulo support.

const loadSeller = async (sellerId) => {
  const seller = await Seller.findById(sellerId).lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  return seller;
};

const parseOr400 = (schema, body, message) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? message, flat);
  }
  return parsed.data;
};

// ── Agreement ─────────────────────────────────────────────────────────────────

/**
 * The agreement a seller must sign: its category's own when the super admin has published one
 * (CouponCategory.agreement), otherwise the general one (CouponSettings). { scope, categoryId,
 * version, text } — version 0 means nothing is published.
 */
export const agreementFor = async (seller, settings = null) => {
  const category = seller.categoryId ? await CouponCategory.findById(seller.categoryId).select('name agreement').lean() : null;
  if ((category?.agreement?.version ?? 0) > 0) {
    return { scope: 'category', categoryId: category._id, categoryName: category.name, version: category.agreement.version, text: category.agreement.text ?? '' };
  }
  const s = settings ?? (await getActiveCouponSettings());
  const version = s.agreementVersion ?? 0;
  return { scope: 'general', categoryId: null, categoryName: null, version, text: version > 0 ? s.agreementText ?? '' : '' };
};

/** Whether the seller's acceptance is of exactly the agreement in force now. */
export const isUpToDate = (seller, current) => {
  const a = seller.agreement;
  if (!(current.version > 0) || !a?.version) return false;
  const scope = a.scope ?? 'general';
  if (scope !== current.scope || a.version !== current.version) return false;
  return current.scope === 'general' || String(a.categoryId) === String(current.categoryId);
};

const agreementView = async (seller, current) => {
  const accepted = seller.agreement?.version ? seller.agreement : null;
  const acceptedBy = accepted?.acceptedBy ? await SellerUser.findById(accepted.acceptedBy).select('name').lean() : null;
  return {
    published: current.version > 0,
    version: current.version,
    // 'category' — this business type's own agreement; 'general' — the one for every partner.
    scope: current.scope,
    categoryName: current.categoryName,
    text: current.text,
    acceptance: accepted
      ? { version: accepted.version, acceptedAt: accepted.acceptedAt, acceptedByName: acceptedBy?.name ?? null }
      : null,
    // True when the owner has accepted the agreement in force now.
    upToDate: isUpToDate(seller, current),
  };
};

/** GET /api/seller/agreement */
export const getAgreement = async (sellerId) => {
  const seller = await loadSeller(sellerId);
  return agreementView(seller, await agreementFor(seller));
};

export const acceptSchema = z.object({ version: z.number().int().min(1) }).strict();

/**
 * POST /api/seller/agreement/accept { version } — the version the owner read. Refused when it is
 * no longer the one in force (they must read the new text first). Accepting the same agreement
 * again keeps the first acceptance.
 */
export const acceptAgreement = async (sellerId, userId, body, { ip = null } = {}) => {
  const { version } = parseOr400(acceptSchema, body, 'Invalid agreement acceptance');
  const seller = await loadSeller(sellerId);
  const current = await agreementFor(seller);
  if (current.version === 0) throw new ApiError(409, 'NO_AGREEMENT', 'There is no partner agreement to accept yet');
  if (version !== current.version) {
    throw new ApiError(409, 'AGREEMENT_CHANGED', 'The agreement has been updated — please read the new version', { currentVersion: current.version });
  }
  if (!isUpToDate(seller, current)) {
    await Seller.updateOne(
      { _id: sellerId },
      {
        $set: {
          agreement: { scope: current.scope, categoryId: current.categoryId, version: current.version, acceptedAt: new Date(), acceptedBy: userId, ip: ip ?? null },
        },
      }
    );
  }
  return agreementView(await loadSeller(sellerId), current);
};

// ── Profile ───────────────────────────────────────────────────────────────────

const profileView = async (seller) => {
  const [category, subs, current] = await Promise.all([
    CouponCategory.findById(seller.categoryId).select('key name').lean(),
    sellerSubscriptions(seller._id),
    agreementFor(seller),
  ]);
  return {
    _id: seller._id,
    status: seller.status,
    businessName: seller.businessName,
    category: category ? { _id: category._id, key: category.key, name: category.name } : null,
    gstNumber: seller.gstNumber ?? null,
    establishedOn: seller.establishedOn ?? null,
    address: seller.address ?? null,
    location: toLocationView(seller.location),
    businessPhone: seller.businessPhone ?? null,
    owner: {
      name: seller.owner?.name ?? null,
      panMasked: maskPan(seller.owner?.panLast4),
      aadhaarMasked: maskAadhaar(seller.owner?.aadhaarLast4),
    },
    approvedAt: seller.status === 'active' ? seller.reviewedAt ?? null : null,
    currentPlan: subs.currentPlan,
    activePlans: subs.activePlans,
    agreement: { upToDate: isUpToDate(seller, current) },
    editableFields: CONTACT_FIELDS,
  };
};

/** GET /api/seller/profile */
export const getProfile = async (sellerId) => profileView(await loadSeller(sellerId));

/** PATCH /api/seller/profile — contact fields only; anything else → 409 PROFILE_LOCKED. */
export const updateProfile = async (sellerId, body) => {
  const sent = Object.keys(body ?? {});
  const locked = sent.filter((k) => !CONTACT_FIELDS.includes(k));
  if (locked.length) {
    throw new ApiError(409, 'PROFILE_LOCKED', 'Only the phone number, address and map pin can be changed here — contact Yulo support for anything else', {
      lockedFields: locked,
    });
  }
  if (sent.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to change');
  const data = parseOr400(contactSchema, body, 'Invalid business details');
  const seller = await Seller.findById(sellerId);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  if (data.businessPhone !== undefined) seller.businessPhone = data.businessPhone;
  if (data.address !== undefined) seller.address = data.address;
  applyLocation(seller, data.location);
  await seller.save();
  return profileView(seller.toObject());
};
