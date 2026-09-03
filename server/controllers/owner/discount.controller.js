import { z } from 'zod';
import Discount from '../../models/Discount.js';
import * as uploadService from '../../services/upload.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Base fields without refine — extend first, then refine per branch (Zod v4 requirement)
const baseFields = {
  offerName: z.string().min(1),
  code: z.string().optional(),
  applicableTo: z.enum(['dine_in', 'delivery', 'both']).default('both'),
  minimumOrderValue: z.number().min(0).default(0),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  applicableTableNumbers: z.array(z.string()).optional(),
  applicableCategories: z.array(z.string()).optional(),
  applicableSubCategories: z.array(z.string()).optional(),
  applicableItems: z.array(z.string()).optional(),
  isFeatured: z.boolean().optional().default(false),
};

const dateRefine = (d) => d.endDate > d.startDate;
const dateRefineOpts = { message: 'endDate must be after startDate', path: ['endDate'] };

const discountSchema = z.discriminatedUnion('type', [
  z.object({ ...baseFields, type: z.literal('percentage'), percentage: z.number().min(1).max(100) })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('flat_amount'), flatAmount: z.number().positive() })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('free_item'), freeItemId: z.string().min(1), freeItemName: z.string().optional() })
    .refine(dateRefine, dateRefineOpts),
  z.object({ ...baseFields, type: z.literal('tablewise'), flatAmount: z.number().positive(), applicableTableNumbers: z.array(z.string()).min(1) })
    .refine(dateRefine, dateRefineOpts),
]);

// Create/update accept multipart/form-data so the offer artwork can ride along in the
// same request. Multipart carries every field as a string, so the typed body the schema
// above expects has to be rebuilt first; a JSON request passes through unchanged because
// each coercion only fires on a string.
const NUMBER_FIELDS = ['minimumOrderValue', 'percentage', 'flatAmount'];
const ARRAY_FIELDS = [
  'applicableTableNumbers', 'applicableCategories', 'applicableSubCategories', 'applicableItems',
];

const coerce = (body = {}) => {
  const out = { ...body };

  for (const key of NUMBER_FIELDS) {
    if (typeof out[key] === 'string') {
      if (out[key].trim() === '') delete out[key];
      else out[key] = Number(out[key]);
    }
  }

  // Arrays arrive JSON-encoded ('["T1","T2"]'); tolerate a bare comma list too.
  for (const key of ARRAY_FIELDS) {
    if (typeof out[key] === 'string') {
      try {
        const parsed = JSON.parse(out[key]);
        out[key] = Array.isArray(parsed) ? parsed : [out[key]];
      } catch {
        out[key] = out[key].split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  if (typeof out.isFeatured === 'string') out.isFeatured = out.isFeatured === 'true';

  // An automatic (non-coupon) offer has no code. Leaving the empty string in would store
  // '' for every such offer, and the sparse unique index on `code` treats '' as a real
  // value — the second automatic offer would be rejected as a duplicate.
  if (out.code === '') delete out.code;

  // `image` is only ever set from the uploaded file below; a client-supplied URL is
  // ignored so nobody can point an offer at an arbitrary host.
  delete out.image;

  return out;
};

const validate = (body) => {
  const result = discountSchema.safeParse(coerce(body));
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid discount data', result.error.flatten());
  }
  return result.data;
};

// Pushes the request's file (if any) to Cloudinary and returns the stored URL alongside
// the public id, so a later DB failure can undo the upload.
const uploadOfferImage = async (req) => {
  if (!req.file) return {};
  try {
    const { secureUrl, publicId } = await uploadService.uploadBuffer({
      buffer: req.file.buffer,
      folder: `yulostores/discounts/${req.restaurant._id}`,
      publicId: `offer_${Date.now()}`,
    });
    return { image: secureUrl, uploadedPublicId: publicId };
  } catch (uploadErr) {
    throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Image upload failed');
  }
};

export const list = asyncHandler(async (req, res) => {
  const discounts = await Discount.find({ restaurantId: req.restaurant._id }).lean();
  sendSuccess(res, 200, 'Discounts', { discounts });
});

export const create = asyncHandler(async (req, res) => {
  const data = validate(req.body);
  const { image, uploadedPublicId } = await uploadOfferImage(req);

  let discount;
  try {
    discount = await Discount.create({
      ...data,
      ...(image && { image }),
      restaurantId: req.restaurant._id,
    });
  } catch (err) {
    if (uploadedPublicId) await uploadService.deleteImage(uploadedPublicId).catch(() => {});
    throw err;
  }

  sendSuccess(res, 201, 'Discount created', { discount });
});

export const update = asyncHandler(async (req, res) => {
  const data = validate(req.body);

  // Read the current artwork first: the old asset is only removed once the new URL is
  // safely written, so a failed update never leaves the offer pointing at nothing.
  const existing = await Discount.findOne({
    _id: req.params.dId,
    restaurantId: req.restaurant._id,
  }).lean();
  if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Discount not found');

  const { image, uploadedPublicId } = await uploadOfferImage(req);

  let discount;
  try {
    discount = await Discount.findByIdAndUpdate(
      existing._id,
      { $set: { ...data, ...(image && { image }) } },
      { new: true }
    );
  } catch (err) {
    if (uploadedPublicId) await uploadService.deleteImage(uploadedPublicId).catch(() => {});
    throw err;
  }

  if (image && existing.image) {
    const oldPublicId = uploadService.extractPublicId(existing.image);
    if (oldPublicId) await uploadService.deleteImage(oldPublicId).catch(() => {});
  }

  sendSuccess(res, 200, 'Discount updated', { discount });
});

export const remove = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndDelete({
    _id: req.params.dId,
    restaurantId: req.restaurant._id,
  });
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found');

  // Deleting the record orphans its artwork otherwise — best effort, the offer is gone
  // either way.
  if (discount.image) {
    const publicId = uploadService.extractPublicId(discount.image);
    if (publicId) await uploadService.deleteImage(publicId).catch(() => {});
  }

  sendSuccess(res, 200, 'Discount deleted', null);
});

export const publish = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.dId, restaurantId: req.restaurant._id, status: 'draft' },
    { $set: { status: 'active' } },
    { new: true }
  );
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found or already active');
  sendSuccess(res, 200, 'Discount published', { discount });
});

export const draft = asyncHandler(async (req, res) => {
  const discount = await Discount.findOneAndUpdate(
    { _id: req.params.dId, restaurantId: req.restaurant._id, status: 'active' },
    { $set: { status: 'draft' } },
    { new: true }
  );
  if (!discount) throw new ApiError(404, 'NOT_FOUND', 'Discount not found or already draft');
  sendSuccess(res, 200, 'Discount reverted to draft', { discount });
});
