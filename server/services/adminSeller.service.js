import Seller from '../models/Seller.js';
import SellerUser from '../models/SellerUser.js';
import CouponCategory from '../models/CouponCategory.js';
import { decryptField } from '../utils/fieldEncryption.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegExp } from '../utils/regex.js';
import { maskPan, maskAadhaar } from '../utils/kyc.js';
import { logActivity } from './activityLog.service.js';
import { missingSections, toDocumentView, toTeamMemberView } from './sellerOnboarding.service.js';
import { SELLER_STATUSES } from '../config/coupon.config.js';

// The super admin's side of coupon partners: the review queue, a seller's full (masked) record,
// the audited PAN reveal, and the account's lifecycle:
//
//   pending ──approve──→ active ──suspend──→ suspended ──reactivate──→ active
//      └──reject──→ rejected ──(owner resubmits)──→ pending
//
// Every transition is one conditional update on the expected current status, so two admins
// acting at once can't both succeed; anything else is 409 INVALID_STATE. Every action is
// written to the admin activity log.

const LIST_LIMIT_MAX = 100;

const toLocationView = (location) =>
  location?.coordinates?.length === 2 ? { lng: location.coordinates[0], lat: location.coordinates[1] } : null;

const toListRow = (s, category, owner) => ({
  _id: s._id,
  businessName: s.businessName,
  category: category ? { _id: category._id, key: category.key, name: category.name } : null,
  status: s.status,
  city: s.address?.city ?? null,
  ownerName: s.owner?.name ?? owner?.name ?? null,
  ownerPhone: owner?.phone ?? s.owner?.phone ?? null,
  submittedAt: s.submittedAt,
  reviewedAt: s.reviewedAt,
  createdAt: s.createdAt,
  complete: missingSections(s).length === 0,
});

/** GET /api/admin/sellers — filters: status, categoryId, search (business, owner name or phone). */
export const listSellers = async ({ status, categoryId, search, page = 1, limit = 20 }) => {
  const filter = {};
  if (status) filter.status = status;
  if (categoryId) filter.categoryId = categoryId;
  if (search) {
    const re = new RegExp(escapeRegExp(search.trim()), 'i');
    const ownerSellerIds = await SellerUser.find({ role: 'owner', phone: re }).distinct('sellerId');
    filter.$or = [{ businessName: re }, { 'owner.name': re }, { 'owner.phone': re }, { _id: { $in: ownerSellerIds } }];
  }

  const perPage = Math.min(Math.max(Number(limit) || 20, 1), LIST_LIMIT_MAX);
  const pageNo = Math.max(Number(page) || 1, 1);
  const [sellers, total, counts] = await Promise.all([
    Seller.find(filter).sort({ submittedAt: -1, createdAt: -1 }).skip((pageNo - 1) * perPage).limit(perPage).lean(),
    Seller.countDocuments(filter),
    Seller.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const [categories, owners] = await Promise.all([
    CouponCategory.find({ _id: { $in: sellers.map((s) => s.categoryId) } }).select('key name').lean(),
    SellerUser.find({ sellerId: { $in: sellers.map((s) => s._id) }, role: 'owner', removedAt: null }).lean(),
  ]);
  const categoryById = new Map(categories.map((c) => [String(c._id), c]));
  const ownerBySeller = new Map(owners.map((o) => [String(o.sellerId), o]));

  const statusCounts = Object.fromEntries(SELLER_STATUSES.map((s) => [s, 0]));
  for (const c of counts) statusCounts[c._id] = c.count;

  return {
    sellers: sellers.map((s) => toListRow(s, categoryById.get(String(s.categoryId)), ownerBySeller.get(String(s._id)))),
    total,
    page: pageNo,
    pages: Math.ceil(total / perPage),
    statusCounts,
  };
};

const loadLean = async (id) => {
  const seller = await Seller.findById(id).lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  return seller;
};

/** GET /api/admin/sellers/:id — everything about one seller, identity numbers masked. */
export const getSeller = async (id) => {
  const seller = await loadLean(id);
  // Whether the full Aadhaar is on file (the field itself is select: false and never read here).
  const aadhaarStored = await Seller.exists({ _id: seller._id, 'owner.aadhaarEncrypted': { $type: 'string' } });
  const [category, team] = await Promise.all([
    CouponCategory.findById(seller.categoryId).select('key name enabled').lean(),
    SellerUser.find({ sellerId: id }).sort({ createdAt: 1 }).lean(),
  ]);
  return {
    _id: seller._id,
    status: seller.status,
    submittedAt: seller.submittedAt,
    reviewedAt: seller.reviewedAt,
    reviewedBy: seller.reviewedBy,
    rejectionReason: seller.rejectionReason ?? null,
    business: {
      businessName: seller.businessName,
      category,
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
      panRevealable: Boolean(seller.owner?.panLast4),
      // Stored in full (encrypted) since Nov 2026; earlier sellers have only the last 4 digits.
      aadhaarRevealable: Boolean(aadhaarStored),
    },
    users: team.map((u) => ({ ...toTeamMemberView(u), removedAt: u.removedAt ?? null, lastLoginAt: u.lastLoginAt ?? null })),
    documents: (seller.documents ?? []).map(toDocumentView),
    agreement: seller.agreement ?? null,
    smsCreditsBalance: seller.smsCreditsBalance ?? 0,
    missing: missingSections(seller),
    createdAt: seller.createdAt,
  };
};

/** GET /api/admin/sellers/:id/users — every login on the account, removed ones included. */
export const listSellerUsers = async (id) => {
  await loadLean(id);
  const users = await SellerUser.find({ sellerId: id }).sort({ role: 1, createdAt: 1 }).lean();
  return users.map((u) => ({ ...toTeamMemberView(u), removedAt: u.removedAt ?? null, lastLoginAt: u.lastLoginAt ?? null }));
};

const IDENTITY = {
  pan: { encrypted: 'panEncrypted', last4: 'panLast4', label: 'PAN' },
  aadhaar: { encrypted: 'aadhaarEncrypted', last4: 'aadhaarLast4', label: 'Aadhaar number' },
};

/** POST /api/admin/sellers/:id/reveal — the owner's full PAN or Aadhaar, once, audit-logged. */
export const revealIdentity = async (id, adminId, field) => {
  const spec = IDENTITY[field];
  if (!spec) throw new ApiError(400, 'VALIDATION_ERROR', 'field must be "pan" or "aadhaar"');
  const seller = await Seller.findById(id).select(`+owner.${spec.encrypted} owner.${spec.last4}`).lean();
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  if (!seller.owner?.[spec.encrypted]) {
    throw field === 'aadhaar' && seller.owner?.aadhaarLast4
      ? new ApiError(404, 'NOT_STORED', 'Only the last 4 digits were kept for this seller (given before full numbers were stored). Check the uploaded Aadhaar card.')
      : new ApiError(404, 'NOT_FOUND', `No ${spec.label} has been given yet`);
  }

  const value = decryptField(seller.owner[spec.encrypted]);
  await logActivity({
    adminId,
    action: `seller.reveal_${field}`,
    targetType: 'seller',
    targetId: seller._id,
    metadata: { [spec.last4]: seller.owner[spec.last4] },
  });
  return { field, value };
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const transition = async (id, fromStatuses, set, label) => {
  const updated = await Seller.findOneAndUpdate({ _id: id, status: { $in: fromStatuses } }, { $set: set }, { new: true }).lean();
  if (updated) return updated;
  const current = await Seller.findById(id).select('status').lean();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  throw new ApiError(409, 'INVALID_STATE', `A ${current.status} seller cannot be ${label}`, { status: current.status });
};

// Ends every session the seller's people hold (services/auth.service.js — sessionVersion).
const signEveryoneOut = (sellerId) => SellerUser.updateMany({ sellerId }, { $inc: { sessionVersion: 1 } });

/** Approve a submitted application; its team (except anyone removed) can then sign in. */
export const approveSeller = async (id, adminId) => {
  const seller = await loadLean(id);
  if (seller.status === 'pending' && !seller.submittedAt) {
    throw new ApiError(409, 'NOT_SUBMITTED', 'The owner has not sent this application for review yet');
  }
  const missing = missingSections(seller);
  if (seller.status === 'pending' && missing.length) {
    throw new ApiError(409, 'ONBOARDING_INCOMPLETE', 'The application is missing details', { missing });
  }
  const now = new Date();
  const updated = await transition(id, ['pending'], { status: 'active', reviewedAt: now, reviewedBy: adminId, rejectionReason: null }, 'approved');
  const { modifiedCount } = await SellerUser.updateMany({ sellerId: id, removedAt: null, isActive: false }, { $set: { isActive: true } });
  await logActivity({ adminId, action: 'SELLER_APPROVED', targetType: 'seller', targetId: updated._id, metadata: { usersActivated: modifiedCount } });
  return getSeller(id);
};

export const rejectSeller = async (id, adminId, reason) => {
  const updated = await transition(
    id,
    ['pending'],
    { status: 'rejected', rejectionReason: reason, reviewedAt: new Date(), reviewedBy: adminId },
    'rejected'
  );
  await logActivity({ adminId, action: 'SELLER_REJECTED', targetType: 'seller', targetId: updated._id, metadata: { reason } });
  return getSeller(id);
};

export const suspendSeller = async (id, adminId, reason = null) => {
  const updated = await transition(id, ['active'], { status: 'suspended', reviewedAt: new Date(), reviewedBy: adminId }, 'suspended');
  await signEveryoneOut(id);
  await logActivity({ adminId, action: 'SELLER_SUSPENDED', targetType: 'seller', targetId: updated._id, metadata: { reason } });
  return getSeller(id);
};

export const reactivateSeller = async (id, adminId) => {
  const updated = await transition(id, ['suspended'], { status: 'active', reviewedAt: new Date(), reviewedBy: adminId }, 'reactivated');
  await logActivity({ adminId, action: 'SELLER_REACTIVATED', targetType: 'seller', targetId: updated._id });
  return getSeller(id);
};

/** The stored document, for streaming to the admin portal. */
export const findDocument = async (id, docId) => {
  const seller = await loadLean(id);
  const doc = (seller.documents ?? []).find((d) => String(d._id) === docId);
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Document not found');
  return doc;
};
