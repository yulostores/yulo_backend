import { z } from 'zod';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import * as uploadService from '../../services/upload.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// NOTE on activityLog.service.js: intentionally not used anywhere in this file. Its
// AdminActivityLog model requires `adminId` (a ref to User) on every entry — these are
// partner-initiated writes with no admin actor, so there's no valid value to put there.
// Force-fitting a partner's own id into an "adminId" field would create a dangling/incorrect
// ref. A real partner-side audit trail would need its own log model; out of scope here.

const DOCUMENT_FIELD_TYPES = {
  aadharCard: 'aadhar_card',
  drivingLicense: 'driving_license',
  vehicleRc: 'vehicle_rc',
  insuranceDocument: 'insurance_document',
  profilePhoto: 'profile_photo',
};

const REQUIRED_DOCUMENT_TYPES = Object.values(DOCUMENT_FIELD_TYPES);

const extractPublicId = (url) => url.match(/\/upload\/v\d+\/(.+)\.[a-zA-Z0-9]+$/)?.[1] ?? null;

// Editing one of these after approval re-triggers review — the stricter option, per design: these
// are the exact same fields admin verified during onboarding (aadhar/PAN against the uploaded ID
// documents, vehicle registration/RC/insurance against the vehicle_rc/insurance_document uploads,
// bank account number/IFSC as the actual payout destination). Cosmetic fields (name spelling,
// vehicle model/color, bank branch name, gender) don't gate re-review — only what was actually
// verified against a document or drives real money movement does. A post-approval edit must never
// silently bypass verification on these.
const KYC_SENSITIVE_PERSONAL_FIELDS = ['aadharNumber', 'panNumber'];
const KYC_SENSITIVE_VEHICLE_FIELDS = ['number', 'rcNumber', 'insuranceNumber', 'insuranceValidTill'];
const KYC_SENSITIVE_BANK_FIELDS = ['accountNumber', 'ifscCode'];

const valuesEqual = (a, b) => {
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return a === b;
};

const revertApprovalIfNeeded = (partner, changedSensitiveFields) => {
  if (partner.verificationStatus !== 'approved' || changedSensitiveFields.length === 0) return;

  partner.verificationStatus = 'under_review';
  partner.verificationNotes = `Automatic re-review: ${changedSensitiveFields.join(', ')} changed after approval.`;
  partner.verifiedAt = null;
  partner.verifiedBy = null;
};

const PERSONAL_FIELDS = [
  'fullName',
  'email',
  'dateOfBirth',
  'gender',
  'emergencyPhone',
  'aadharNumber',
  'panNumber',
];

// Delivery partners ride on public roads, which needs a driving licence — 18 or older. The
// app's date picker stops at 18 years ago; this refuses anything later sent directly.
export const MIN_PARTNER_AGE_YEARS = 18;
const latestAllowedBirthDate = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - MIN_PARTNER_AGE_YEARS);
  return d;
};

const personalSchema = z.object({
  fullName: z.string().min(2).optional(),
  email: z.string().email().optional(),
  dateOfBirth: z.coerce
    .date()
    .refine((d) => d <= latestAllowedBirthDate(), {
      message: `You must be at least ${MIN_PARTNER_AGE_YEARS} years old to deliver.`,
    })
    .optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  emergencyPhone: z.string().optional(),
  aadharNumber: z.string().optional(),
  panNumber: z.string().optional(),
});

export const updatePersonal = asyncHandler(async (req, res) => {
  const result = personalSchema.safeParse(req.body);
  if (!result.success) {
    const details = result.error.flatten();
    // The age rule's own sentence, so the app can show the rider why (it displays the message).
    const message = details.fieldErrors.dateOfBirth?.[0] ?? 'Invalid personal details';
    throw new ApiError(400, 'VALIDATION_ERROR', message, details);
  }

  const partner = await DeliveryPartner.findById(req.partner._id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  const changedSensitiveFields = KYC_SENSITIVE_PERSONAL_FIELDS.filter(
    (field) => result.data[field] !== undefined && !valuesEqual(result.data[field], partner[field])
  );

  for (const field of PERSONAL_FIELDS) {
    if (result.data[field] !== undefined) partner[field] = result.data[field];
  }
  revertApprovalIfNeeded(partner, changedSensitiveFields);
  await partner.save();

  sendSuccess(res, 200, 'Personal details updated', { partner });
});

const vehicleSchema = z.object({
  vehicle: z.object({
    model: z.string().optional(),
    number: z.string().optional(),
    type: z.enum(['2_wheeler', 'ev_2_wheeler', 'non_rto_2_wheeler']).optional(),
    rcNumber: z.string().optional(),
    insuranceProvider: z.string().optional(),
    insuranceNumber: z.string().optional(),
    insuranceValidTill: z.coerce.date().optional(),
  }),
});

export const updateVehicle = asyncHandler(async (req, res) => {
  const result = vehicleSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid vehicle details', result.error.flatten());
  }

  // fleetType is intentionally NOT accepted here. Delivery-Partner/src/screens/onboarding/
  // VehicleDetailsForm.jsx (checked before writing this) has no fleet-type selection UI at all —
  // fleetType only appears post-onboarding (Home, Profile, FleetChangeRequest, VegCheckpoint,
  // IncomingOrder). It keeps its schema default ('standard') through onboarding; changing it is
  // the FleetChangeRequest flow (Step 11) or an admin action, not part of onboarding.
  const partner = await DeliveryPartner.findById(req.partner._id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  const changedSensitiveFields = KYC_SENSITIVE_VEHICLE_FIELDS.filter((field) => {
    const newValue = result.data.vehicle[field];
    return newValue !== undefined && !valuesEqual(newValue, partner.vehicle?.[field]);
  });

  partner.vehicle = result.data.vehicle;
  revertApprovalIfNeeded(partner, changedSensitiveFields);
  await partner.save();

  sendSuccess(res, 200, 'Vehicle details updated', { partner });
});

const bankSchema = z.object({
  bankDetails: z.object({
    bankName: z.string().optional(),
    accountHolderName: z.string().optional(),
    accountNumber: z.string().optional(),
    accountType: z.enum(['savings', 'current']).optional(),
    ifscCode: z.string().optional(),
    branchName: z.string().optional(),
    upiId: z.string().optional(),
  }),
});

export const updateBank = asyncHandler(async (req, res) => {
  const result = bankSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid bank details', result.error.flatten());
  }

  const partner = await DeliveryPartner.findById(req.partner._id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  const changedSensitiveFields = KYC_SENSITIVE_BANK_FIELDS.filter((field) => {
    const newValue = result.data.bankDetails[field];
    return newValue !== undefined && !valuesEqual(newValue, partner.bankDetails?.[field]);
  });

  partner.bankDetails = result.data.bankDetails;
  revertApprovalIfNeeded(partner, changedSensitiveFields);
  await partner.save();

  sendSuccess(res, 200, 'Bank details updated', { partner });
});

export const uploadOnboardingDocuments = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.partner._id);
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  const folder = `yulostores/delivery-partners/${partner._id}`;
  const uploadedPublicIds = [];
  const newDocuments = [];

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
      newDocuments.push({ type: docType, url: secureUrl });
    }
  } catch (uploadErr) {
    await Promise.all(uploadedPublicIds.map((id) => uploadService.deleteImage(id).catch(() => {})));
    throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Document upload failed');
  }

  if (newDocuments.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No document files were provided');
  }

  // Replace, don't append: resubmitting a document after rejection must overwrite the existing
  // entry for that type, not accumulate duplicates.
  const newTypes = new Set(newDocuments.map((d) => d.type));
  const replacedDocuments = partner.documents.filter((d) => newTypes.has(d.type));
  partner.documents = partner.documents.filter((d) => !newTypes.has(d.type)).concat(newDocuments);
  await partner.save();

  // Best-effort cleanup of the Cloudinary assets that were just superseded — otherwise every
  // resubmission leaks a permanently-orphaned file.
  await Promise.all(
    replacedDocuments
      .map((d) => extractPublicId(d.url))
      .filter(Boolean)
      .map((id) => uploadService.deleteImage(id).catch(() => {}))
  );

  sendSuccess(res, 200, 'Documents uploaded', { documents: partner.documents });
});

export const submitForReview = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.partner._id).lean();
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  if (partner.verificationStatus === 'under_review') {
    throw new ApiError(400, 'ALREADY_UNDER_REVIEW', 'Onboarding is already under review');
  }
  if (partner.verificationStatus === 'approved') {
    throw new ApiError(400, 'ALREADY_APPROVED', 'This partner is already verified');
  }
  if (partner.verificationStatus === 'rejected') {
    throw new ApiError(400, 'REJECTED', 'This application was rejected — contact support');
  }
  // Reachable states past this point: 'pending_documents' (first submission) and
  // 'resubmission_required' (admin asked for fixes) — both are valid to submit from. Without
  // allowing the latter, a partner told to fix their documents could never move state again.

  const missing = [];
  if (!partner.fullName) missing.push('fullName');
  if (!partner.phone) missing.push('phone');
  const presentDocTypes = new Set((partner.documents || []).map((d) => d.type));
  for (const type of REQUIRED_DOCUMENT_TYPES) {
    if (!presentDocTypes.has(type)) missing.push(`document:${type}`);
  }
  if (!partner.bankDetails?.accountNumber) missing.push('bankDetails.accountNumber');
  // What the vehicle is and its registration — a non-RTO EV (low-speed scooter) has none.
  if (!partner.vehicle?.model?.trim()) missing.push('vehicle.model');
  if (partner.vehicle?.type !== 'non_rto_2_wheeler' && !partner.vehicle?.number?.trim()) {
    missing.push('vehicle.number');
  }

  if (missing.length > 0) {
    throw new ApiError(
      400,
      'INCOMPLETE_ONBOARDING',
      'Complete all onboarding steps before submitting for review',
      { missing }
    );
  }

  const updated = await DeliveryPartner.findByIdAndUpdate(
    req.partner._id,
    { $set: { verificationStatus: 'under_review' } },
    { new: true }
  );

  sendSuccess(res, 200, 'Submitted for review', { partner: updated });
});

export const getStatus = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.partner._id).lean();
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  sendSuccess(res, 200, 'Onboarding status', {
    verificationStatus: partner.verificationStatus,
    verificationNotes: partner.verificationNotes ?? null,
    documents: partner.documents,
  });
});
