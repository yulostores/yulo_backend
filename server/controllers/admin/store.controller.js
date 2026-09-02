import crypto from 'crypto';
import { z } from 'zod';
import Restaurant from '../../models/Restaurant.js';
import User from '../../models/User.js';
import Bill from '../../models/Bill.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import { hashPassword } from '../../services/auth.service.js';
import { STORE_STATUSES, shapeCounts } from '../../services/adminStats.service.js';

// `operatingHours` and the two image fields are here because the admin console edits them
// (Business Hours card, banner URL field on the store profile) — without them those saves
// returned 200 while silently discarding the payload.
const UPDATABLE_FIELDS = [
  'name',
  'description',
  'category',
  'cuisineTypes',
  'address',
  'delivery',
  'settings',
  'plan',
  'operatingHours',
  'logo',
  'bannerImage',
  // The restaurant's own public contact details — distinct from the owner's
  // User.email / User.phone login credentials.
  'email',
  'phone',
  'website',
  'establishedYear',
];

export const list = asyncHandler(async (req, res) => {
  const { status, plan, search, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.approvalStatus = status;
  if (plan) filter.plan = plan;
  if (search) filter.name = { $regex: search, $options: 'i' };

  const skip = (Number(page) - 1) * Number(limit);
  const [stores, total, statusCountsAgg] = await Promise.all([
    Restaurant.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('ownerId', 'name email phone')
      .lean(),
    Restaurant.countDocuments(filter),
    Restaurant.aggregate([{ $group: { _id: '$approvalStatus', count: { $sum: 1 } } }]),
  ]);

  const revenueAgg = await Bill.aggregate([
    { $match: { status: 'paid', restaurantId: { $in: stores.map((s) => s._id) } } },
    { $group: { _id: '$restaurantId', revenue: { $sum: '$grandTotal' } } },
  ]);
  const revenueByStore = new Map(revenueAgg.map((r) => [r._id.toString(), r.revenue]));
  const storesWithRevenue = stores.map((s) => ({
    ...s,
    revenue: revenueByStore.get(s._id.toString()) ?? 0,
  }));

  sendSuccess(res, 200, 'Stores', {
    stores: storesWithRevenue,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    statusCounts: shapeCounts(STORE_STATUSES, statusCountsAgg),
  });
});

const createSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  description: z.string().optional(),
  cuisineTypes: z.array(z.string()).optional(),
  logo: z.string().optional(),
  bannerImage: z.string().optional(),
  coverImage: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  establishedYear: z.number().int().min(1800).optional(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      pincode: z.string().optional(),
    })
    .optional(),
  location: z
    .object({ coordinates: z.array(z.number()).length(2) })
    .optional(),
  delivery: z
    .object({
      radiusKm: z.number().optional(),
      baseCharge: z.number().optional(),
      freeThreshold: z.number().optional(),
      estimatedMinutes: z.number().optional(),
    })
    .optional(),
  settings: z.record(z.any()).optional(),
  // HHMM integers, matching Restaurant.operatingHours (900 = 09:00).
  operatingHours: z
    .array(
      z.object({
        day: z.enum([
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
          'sunday',
        ]),
        isOpen: z.boolean().optional(),
        openTime: z.number().int().min(0).max(2359).optional(),
        closeTime: z.number().int().min(0).max(2359).optional(),
      })
    )
    .optional(),
  plan: z.enum(['trial', 'basic', 'standard', 'premium']).optional(),
  owner: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
  }),
});

export const create = asyncHandler(async (req, res) => {
  const result = createSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid store data', result.error.flatten());
  }
  const { owner, location, ...storeData } = result.data;

  let ownerUser = await User.findOne({ email: owner.email });
  let tempPassword = null;

  if (ownerUser && ownerUser.role !== 'restaurant_owner') {
    throw new ApiError(409, 'DUPLICATE_KEY', 'This email is already registered under a different account role');
  }

  if (!ownerUser) {
    tempPassword = crypto.randomBytes(9).toString('base64url');
    ownerUser = await User.create({
      name: owner.name,
      email: owner.email,
      phone: owner.phone,
      passwordHash: await hashPassword(tempPassword),
      role: 'restaurant_owner',
    });
  }

  const store = await Restaurant.create({
    ...storeData,
    ownerId: ownerUser._id,
    location: { type: 'Point', coordinates: location?.coordinates ?? [0, 0] },
    approvalStatus: 'active',
    reviewedAt: new Date(),
    reviewedBy: req.user._id,
  });

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_CREATED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 201, 'Store created', {
    store,
    ownerCreated: tempPassword !== null,
    tempPassword,
  });
});

export const getOne = asyncHandler(async (req, res) => {
  const store = await Restaurant.findById(req.params.id).populate('ownerId', 'name email phone').lean();
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');
  sendSuccess(res, 200, 'Store', { store });
});

export const approve = asyncHandler(async (req, res) => {
  const store = await Restaurant.findByIdAndUpdate(
    req.params.id,
    // rejectionReason is cleared, not left behind: approving is the resolution of whatever
    // the earlier rejection said, and a live store carrying "your FSSAI licence is
    // unreadable" is one unguarded read away from being shown that as if it still applied.
    {
      $set: {
        approvalStatus: 'active',
        reviewedAt: new Date(),
        reviewedBy: req.user._id,
        rejectionReason: null,
      },
    },
    { new: true }
  );
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_APPROVED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 200, 'Store approved', { store });
});

const rejectSchema = z.object({ reason: z.string().min(1) });

export const reject = asyncHandler(async (req, res) => {
  const result = rejectSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid reject data', result.error.flatten());
  }
  const { reason } = result.data;

  const store = await Restaurant.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        approvalStatus: 'rejected',
        rejectionReason: reason,
        reviewedAt: new Date(),
        reviewedBy: req.user._id,
      },
    },
    { new: true }
  );
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_REJECTED',
    targetType: 'restaurant',
    targetId: store._id,
    metadata: { reason },
  });

  sendSuccess(res, 200, 'Store rejected', { store });
});

export const suspend = asyncHandler(async (req, res) => {
  const store = await Restaurant.findById(req.params.id);
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');
  if (store.approvalStatus !== 'active') {
    throw new ApiError(400, 'INVALID_STATE', 'Only active stores can be suspended');
  }
  store.approvalStatus = 'suspended';
  await store.save();

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_SUSPENDED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 200, 'Store suspended', { store });
});

export const reactivate = asyncHandler(async (req, res) => {
  const store = await Restaurant.findById(req.params.id);
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');
  if (store.approvalStatus !== 'suspended') {
    throw new ApiError(400, 'INVALID_STATE', 'Only suspended stores can be reactivated');
  }
  store.approvalStatus = 'active';
  await store.save();

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_REACTIVATED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 200, 'Store reactivated', { store });
});

export const update = asyncHandler(async (req, res) => {
  const data = {};
  for (const field of UPDATABLE_FIELDS) {
    if (req.body[field] !== undefined) data[field] = req.body[field];
  }

  const store = await Restaurant.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');
  sendSuccess(res, 200, 'Store updated', { store });
});

const noteSchema = z.object({ note: z.string().min(1) });

export const addNote = asyncHandler(async (req, res) => {
  const result = noteSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid note data', result.error.flatten());
  }
  const { note } = result.data;

  const store = await Restaurant.findByIdAndUpdate(
    req.params.id,
    { $push: { adminNotes: { note, addedBy: req.user._id, addedAt: new Date() } } },
    { new: true }
  );
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_NOTE_ADDED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 200, 'Note added', { store });
});

const verifyDocumentSchema = z.object({ status: z.enum(['verified', 'rejected']) });

export const verifyDocument = asyncHandler(async (req, res) => {
  const result = verifyDocumentSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid document status', result.error.flatten());
  }
  const { status } = result.data;

  const updateResult = await Restaurant.updateOne(
    { _id: req.params.id, 'documents._id': req.params.docId },
    { $set: { 'documents.$.status': status } }
  );
  if (updateResult.matchedCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Store or document not found');
  }
  sendSuccess(res, 200, 'Document status updated', null);
});

export const remove = asyncHandler(async (req, res) => {
  const store = await Restaurant.findByIdAndUpdate(
    req.params.id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');

  await logActivity({
    adminId: req.user._id,
    action: 'STORE_REMOVED',
    targetType: 'restaurant',
    targetId: store._id,
  });

  sendSuccess(res, 200, 'Store deactivated', { store });
});
