import mongoose from 'mongoose';
import { z } from 'zod';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import Order from '../../models/Order.js';
import FleetChangeRequest from '../../models/FleetChangeRequest.js';
import * as uploadService from '../../services/upload.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import * as payoutService from '../../services/payout.service.js';

const UPDATABLE_FIELDS = [
  'fullName',
  'phone',
  'dateOfBirth',
  'gender',
  'emergencyPhone',
  'aadharNumber',
  'panNumber',
  'vehicle',
  'bankDetails',
  'status',
];

const DOCUMENT_FIELD_TYPES = {
  aadharCard: 'aadhar_card',
  drivingLicense: 'driving_license',
  vehicleRc: 'vehicle_rc',
  insuranceDocument: 'insurance_document',
  profilePhoto: 'profile_photo',
};

export const list = asyncHandler(async (req, res) => {
  const { search, status, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [partners, total] = await Promise.all([
    DeliveryPartner.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    DeliveryPartner.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Delivery partners', {
    partners,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

export const getOne = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.params.id).lean();
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');
  sendSuccess(res, 200, 'Delivery partner', { partner });
});

export const create = asyncHandler(async (req, res) => {
  const {
    fullName, email, phone, dateOfBirth, gender, emergencyPhone, aadharNumber, panNumber,
    vehicleModel, vehicleNumber, vehicleType, vehicleRcNumber, insuranceProvider,
    insuranceNumber, insuranceValidTill,
    bankName, accountHolderName, accountNumber, accountType, ifscCode, branchName, upiId,
  } = req.body;

  // fullName/email are no longer `required` on the schema (self-registered partners start with
  // just a phone), so this admin-creation path checks them explicitly instead.
  if (!fullName || !email || !phone) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'fullName, email, and phone are required');
  }

  const partnerData = {
    fullName,
    email,
    phone,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    gender,
    emergencyPhone,
    aadharNumber,
    panNumber,
    vehicle: {
      model: vehicleModel,
      number: vehicleNumber,
      type: vehicleType,
      rcNumber: vehicleRcNumber,
      insuranceProvider,
      insuranceNumber,
      insuranceValidTill: insuranceValidTill ? new Date(insuranceValidTill) : undefined,
    },
    bankDetails: {
      bankName,
      accountHolderName,
      accountNumber,
      accountType,
      ifscCode,
      branchName,
      upiId,
    },
  };

  const uploadedPublicIds = [];
  const documents = [];
  const folder = `yulostores/delivery-partners/${Date.now()}`;

  try {
    for (const [fieldName, docType] of Object.entries(DOCUMENT_FIELD_TYPES)) {
      const file = req.files?.[fieldName]?.[0];
      if (!file) continue;

      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: file.buffer,
        folder,
        publicId: `${fieldName}_${Date.now()}`,
        resourceType: file.mimetype === 'application/pdf' ? 'auto' : 'image',
      });
      uploadedPublicIds.push(publicId);
      documents.push({ type: docType, url: secureUrl });
    }
  } catch (uploadErr) {
    await Promise.all(uploadedPublicIds.map((id) => uploadService.deleteImage(id).catch(() => {})));
    throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Document upload failed');
  }

  partnerData.documents = documents;

  let partner;
  try {
    partner = await DeliveryPartner.create(partnerData);
  } catch (err) {
    await Promise.all(uploadedPublicIds.map((id) => uploadService.deleteImage(id).catch(() => {})));
    throw err;
  }

  await logActivity({
    adminId: req.user._id,
    action: 'DELIVERY_PARTNER_ADDED',
    targetType: 'delivery_partner',
    targetId: partner._id,
  });

  sendSuccess(res, 201, 'Delivery partner created', { partner });
});

export const update = asyncHandler(async (req, res) => {
  const data = {};
  for (const field of UPDATABLE_FIELDS) {
    if (req.body[field] !== undefined) data[field] = req.body[field];
  }

  const partner = await DeliveryPartner.findByIdAndUpdate(req.params.id, { $set: data }, { new: true });
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');
  sendSuccess(res, 200, 'Delivery partner updated', { partner });
});

export const remove = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.params.id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  await logActivity({
    adminId: req.user._id,
    action: 'DELIVERY_PARTNER_REMOVED',
    targetType: 'delivery_partner',
    targetId: partner._id,
  });

  await partner.deleteOne();
  sendSuccess(res, 200, 'Delivery partner removed', null);
});

export const getOrders = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = { 'deliveryAssignment.partnerId': req.params.id };
  if (status) filter['deliveryAssignment.status'] = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('restaurantId', 'name address.city')
      .lean(),
    Order.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Delivery partner orders', {
    orders,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

export const getPayouts = asyncHandler(async (req, res) => {
  const { period = 'weekly', page = 1, limit = 10 } = req.query;
  const data = await payoutService.listPayoutsForPartner(req.params.id, {
    periodType: period,
    page,
    limit,
  });
  sendSuccess(res, 200, 'Delivery partner payouts', data);
});

// Rupees, to the paisa. The cap is a typo guard (₹1 lakh on one rider's week).
const MAX_PAYOUT_ADJUSTMENT_RUPEES = 100000;
const rupeeAmount = z
  .number()
  .finite()
  .min(0)
  .max(MAX_PAYOUT_ADJUSTMENT_RUPEES)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'At most two decimal places');
const adjustPayoutSchema = z.object({
  incentives: rupeeAmount.optional(),
  deductions: rupeeAmount.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const adjustPayout = asyncHandler(async (req, res) => {
  const result = adjustPayoutSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payout adjustment', result.error.flatten());
  }

  const payout = await payoutService.adjustPayout(req.params.payoutId, {
    ...result.data,
    adjustedBy: req.user._id,
  });

  await logActivity({
    adminId: req.user._id,
    action: 'PAYOUT_ADJUSTED',
    targetType: 'payout',
    targetId: payout._id,
    metadata: {
      partnerId: payout.partnerId,
      periodStart: payout.periodStart,
      incentives: payout.incentives,
      deductions: payout.deductions,
      netPayable: payout.netPayable,
      notes: result.data.notes ?? null,
    },
  });

  sendSuccess(res, 200, 'Payout adjusted', { payout });
});

const markPaidSchema = z.object({
  payoutIds: z.array(z.string().refine(mongoose.isValidObjectId, 'Invalid payout id')).min(1).max(500),
});

export const markPayoutsPaid = asyncHandler(async (req, res) => {
  const result = markPaidSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid payout ids', result.error.flatten());
  }

  // Only weekly payouts whose week has ended are paid; the rest come back in `skipped` with why.
  const { modifiedCount, skipped } = await payoutService.markPayoutsPaid(result.data.payoutIds);

  await logActivity({
    adminId: req.user._id,
    action: 'PAYOUTS_MARKED_PAID',
    targetType: 'payout',
    metadata: { count: modifiedCount, payoutIds: result.data.payoutIds, skipped },
  });

  sendSuccess(res, 200, 'Payouts marked as paid', { modifiedCount, skipped });
});

export const payoutSummary = asyncHandler(async (req, res) => {
  const { period = 'weekly' } = req.query;
  const data = await payoutService.getPayoutSummary(period);
  sendSuccess(res, 200, 'Payout summary', data);
});

// Mirrors server/controllers/admin/store.controller.js's approve/reject shape, collapsed into a
// single `decision` field since (unlike stores) there's a third outcome — 'request_resubmission'
// — that also needs a notes-style reason. No current-state guard here, same as store's own
// approve/reject (which allow transitioning from any approvalStatus) — consistency over
// inventing stricter rules only for this entity.
const verifySchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'request_resubmission']),
    notes: z.string().min(1).optional(),
  })
  .refine((data) => data.decision === 'approve' || Boolean(data.notes), {
    message: 'notes is required when rejecting or requesting resubmission',
    path: ['notes'],
  });

const VERIFY_DECISION_MAP = {
  approve: { verificationStatus: 'approved', action: 'DELIVERY_PARTNER_VERIFIED' },
  reject: { verificationStatus: 'rejected', action: 'DELIVERY_PARTNER_REJECTED' },
  request_resubmission: {
    verificationStatus: 'resubmission_required',
    action: 'DELIVERY_PARTNER_RESUBMISSION_REQUESTED',
  },
};

export const verify = asyncHandler(async (req, res) => {
  const result = verifySchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid verification decision', result.error.flatten());
  }
  const { decision, notes } = result.data;
  const { verificationStatus, action } = VERIFY_DECISION_MAP[decision];

  const update = { verificationStatus };
  if (decision === 'approve') {
    update.verifiedAt = new Date();
    update.verifiedBy = req.user._id;
    update.verificationNotes = null; // clear any stale rejection/resubmission note
  } else {
    update.verificationNotes = notes;
  }

  const partner = await DeliveryPartner.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  await logActivity({
    adminId: req.user._id,
    action,
    targetType: 'delivery_partner',
    targetId: partner._id,
    metadata: decision === 'approve' ? {} : { notes },
  });

  sendSuccess(res, 200, 'Delivery partner verification updated', { partner });
});

// Per-document review, mirroring store.controller.js's verifyDocument exactly in shape/response —
// but matched by `type` instead of a subdocument `_id`. DeliveryPartner's document subschema is
// `{ _id: false }` and documents are replaced-by-type on re-upload (see onboarding.controller.js),
// so there's no stable per-upload id to match against the way Restaurant's accumulating,
// individually-_id'd documents have; `type` is the correct stable identifier for this domain.
const verifyDocumentSchema = z.object({ status: z.enum(['verified', 'rejected']) });

export const verifyDocument = asyncHandler(async (req, res) => {
  const result = verifyDocumentSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid document status', result.error.flatten());
  }
  const { status } = result.data;

  const updateResult = await DeliveryPartner.updateOne(
    { _id: req.params.id, 'documents.type': req.params.docType },
    { $set: { 'documents.$.status': status } }
  );
  if (updateResult.matchedCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Delivery partner or document not found');
  }
  sendSuccess(res, 200, 'Document status updated', null);
});

// List/resolve for the partner-submitted fleet change requests (server/models/FleetChangeRequest.js,
// server/controllers/partner/fleetChangeRequest.controller.js). Request-centric rather than
// partner-scoped — an admin browsing a queue doesn't necessarily know the partnerId ahead of
// time, same reasoning as admin's own ticket.controller.js being ticket-centric, not
// restaurant-scoped.
export const listFleetChangeRequests = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const [rows, total] = await Promise.all([
    FleetChangeRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('partnerId', 'fullName phone fleetType')
      .lean(),
    FleetChangeRequest.countDocuments(filter),
  ]);

  sendSuccess(res, 200, 'Fleet change requests', {
    rows,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

const fleetChangeDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().optional(),
});

export const resolveFleetChangeRequest = asyncHandler(async (req, res) => {
  const result = fleetChangeDecisionSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid decision', result.error.flatten());
  }
  const { decision, notes } = result.data;

  const request = await FleetChangeRequest.findById(req.params.requestId);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Fleet change request not found');
  if (request.status !== 'pending') {
    throw new ApiError(400, 'INVALID_STATE', 'This request has already been resolved');
  }

  request.status = decision === 'approve' ? 'approved' : 'rejected';
  request.resolvedAt = new Date();
  request.resolvedBy = req.user._id;
  request.resolutionNotes = notes;
  await request.save();

  if (decision === 'approve') {
    await DeliveryPartner.updateOne(
      { _id: request.partnerId },
      { $set: { fleetType: request.requestedFleetType } }
    );
  }

  await logActivity({
    adminId: req.user._id,
    action: decision === 'approve' ? 'FLEET_CHANGE_APPROVED' : 'FLEET_CHANGE_REJECTED',
    targetType: 'delivery_partner',
    targetId: request.partnerId,
    metadata: { requestId: request._id.toString(), requestedFleetType: request.requestedFleetType },
  });

  sendSuccess(res, 200, 'Fleet change request resolved', { request });
});
