import { z } from 'zod';
import User from '../models/User.js';
import * as userService from '../services/user.service.js';
import * as uploadService from '../services/upload.service.js';
import * as myCouponsService from '../services/myCoupons.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ageOn } from '../utils/couponCode.js';
import { GENDERS } from '../config/coupon.config.js';

// The ages a customer may give (an app user must be at least 13). Checked on the calendar date
// in India, the same way coupon reports reckon age (utils/couponCode.js#ageOn).
const MIN_AGE = 13;
const MAX_AGE = 110;

// 'YYYY-MM-DD' → that calendar date at 00:00 UTC (05:30 in India, so still the same date there).
const dateOfBirthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be YYYY-MM-DD')
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    // Rejects 2001-02-30 and the like: Date rolls them over to another day.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: 'custom', message: 'Enter a real date of birth' });
      return z.NEVER;
    }
    const age = ageOn(date);
    if (age < MIN_AGE || age > MAX_AGE) {
      ctx.addIssue({ code: 'custom', message: `Age must be between ${MIN_AGE} and ${MAX_AGE}` });
      return z.NEVER;
    }
    return date;
  });

const updateProfileSchema = z
  .object({
    // Bounded and shaped like everywhere else: a 300-character name and a phone of "12" both
    // saved from the owner's Profile screen. `phone: null` removes it (see updateMe).
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80, 'Name must be at most 80 characters').optional(),
    phone: z.string().trim().regex(/^\d{10}$/, 'Enter a valid 10-digit phone number').nullable().optional(),
    profilePicture: z.string().url().optional(),
    // `avatarUrl` is an accepted alias for `profilePicture`, not a second field — see the
    // comment on User.js's `preferences` field for why no separate avatarUrl column exists.
    avatarUrl: z.string().url().optional(),
    // Optional demographics for coupon reports. `null` clears a value.
    gender: z.enum(GENDERS, { message: `Gender must be one of: ${GENDERS.join(', ')}` }).nullable().optional(),
    dateOfBirth: dateOfBirthSchema.nullable().optional(),
  })
  .transform(({ avatarUrl, ...rest }) => (avatarUrl ? { ...rest, profilePicture: avatarUrl } : rest));

export const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('-passwordHash').lean();
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  sendSuccess(res, 200, 'Profile', { user });
});

export const updateMe = asyncHandler(async (req, res) => {
  // multipart/form-data delivers every field as a string, and a form typically posts an
  // empty string for an input the user left blank. Drop those before validation so an
  // untouched Name doesn't trip `min(2)` and an untouched avatar URL isn't parsed as a
  // malformed URL. JSON callers are unchanged — they simply omit the keys.
  const body = { ...req.body };
  // A JSON `phone: ""` is the Profile screen clearing the number on purpose; dropping it with
  // the multipart blanks below made "remove my phone" a silent no-op.
  const clearsPhone = !req.is('multipart/form-data') && typeof body.phone === 'string' && body.phone.trim() === '';
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.trim() === '') delete body[key];
  }
  if (clearsPhone) body.phone = null;

  const result = updateProfileSchema.safeParse(body);
  if (!result.success) {
    const flat = result.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? 'Invalid input', flat);
  }

  const updates = { ...result.data };
  const unset = {};
  // A restaurant owner signs in with their mobile number — removing it would lock them out.
  if (updates.phone === null && req.user.role === 'restaurant_owner') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Your mobile number is your login and can\'t be removed');
  }
  if (updates.phone === null) {
    delete updates.phone;
    unset.phone = 1; // sparse unique index: a stored null would still collide
  }

  // `authenticate` puts only _id/role/name/email on req.user, so the outgoing avatar has
  // to be read before the write to know what to reap afterwards. Only worth a query on
  // the upload path.
  let previousPicture = null;
  let uploadedPublicId;

  if (req.file) {
    const current = await User.findById(req.user._id).select('profilePicture').lean();
    previousPicture = current?.profilePicture ?? null;

    try {
      const { secureUrl, publicId } = await uploadService.uploadBuffer({
        buffer: req.file.buffer,
        folder: `yulostores/avatars/${req.user._id}`,
        publicId: `avatar_${Date.now()}`,
      });
      // An uploaded file wins over a profilePicture/avatarUrl string in the same request.
      updates.profilePicture = secureUrl;
      uploadedPublicId = publicId;
    } catch (uploadErr) {
      throw new ApiError(500, 'UPLOAD_FAILED', uploadErr?.message ?? 'Avatar upload failed');
    }
  }

  let user;
  try {
    user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates, ...(Object.keys(unset).length && { $unset: unset }) },
      { new: true }
    );
  } catch (err) {
    // The DB write failed — don't strand the image we just pushed to Cloudinary.
    if (uploadedPublicId) await uploadService.deleteImage(uploadedPublicId).catch(() => {});
    throw err;
  }

  // Delete the superseded avatar only after the write succeeds, so a failed save never
  // costs the user the picture they still have.
  if (previousPicture && previousPicture !== updates.profilePicture) {
    const oldPublicId = uploadService.extractPublicId(previousPicture);
    if (oldPublicId) await uploadService.deleteImage(oldPublicId).catch(() => {});
  }

  sendSuccess(res, 200, 'Profile updated', { user });
});

export const addAddress = asyncHandler(async (req, res) => {
  const savedAddresses = await userService.addAddress(req.user._id, req.body);
  sendSuccess(res, 201, 'Address added', { savedAddresses });
});

export const updateAddress = asyncHandler(async (req, res) => {
  const savedAddresses = await userService.updateAddress(req.user._id, req.params.addrId, req.body);
  sendSuccess(res, 200, 'Address updated', { savedAddresses });
});

export const setDefaultAddress = asyncHandler(async (req, res) => {
  const savedAddresses = await userService.setDefaultAddress(req.user._id, req.params.addrId);
  sendSuccess(res, 200, 'Default address set', { savedAddresses });
});

export const removeAddress = asyncHandler(async (req, res) => {
  const savedAddresses = await userService.removeAddress(req.user._id, req.params.addrId);
  sendSuccess(res, 200, 'Address removed', { savedAddresses });
});

export const getPreferences = asyncHandler(async (req, res) => {
  const preferences = await userService.getPreferences(req.user._id);
  sendSuccess(res, 200, 'Preferences', { preferences });
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const preferences = await userService.updatePreferences(req.user._id, req.body);
  sendSuccess(res, 200, 'Preferences updated', { preferences });
});

export const registerDevice = asyncHandler(async (req, res) => {
  const { deviceToken, platform } = req.body;
  const device = await userService.registerDevice(req.user._id, deviceToken, platform);
  sendSuccess(res, 200, 'Device registered', { device });
});

export const removeDevice = asyncHandler(async (req, res) => {
  await userService.removeDevice(req.user._id, req.params.deviceToken);
  sendSuccess(res, 200, 'Device removed', null);
});

// ── My Coupons (CB6) ──────────────────────────────────────────────────────────

const myCouponsQuerySchema = z.object({
  status: z.enum(myCouponsService.MY_COUPON_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/users/me/coupons?status=issued|redeemed|expired|void&page=&limit=
export const listMyCoupons = asyncHandler(async (req, res) => {
  const parsed = myCouponsQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid coupon filter', parsed.error.flatten());
  sendSuccess(res, 200, 'Coupons', await myCouponsService.listMyCoupons(req.user._id, parsed.data));
});

// GET /api/users/me/coupons/:id
export const getMyCoupon = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Coupon', { coupon: await myCouponsService.getMyCoupon(req.user._id, req.params.id) });
});
