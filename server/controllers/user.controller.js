import { z } from 'zod';
import User from '../models/User.js';
import * as userService from '../services/user.service.js';
import * as uploadService from '../services/upload.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const updateProfileSchema = z
  .object({
    name: z.string().min(2).optional(),
    phone: z.string().optional(),
    profilePicture: z.string().url().optional(),
    // `avatarUrl` is an accepted alias for `profilePicture`, not a second field — see the
    // comment on User.js's `preferences` field for why no separate avatarUrl column exists.
    avatarUrl: z.string().url().optional(),
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
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.trim() === '') delete body[key];
  }

  const result = updateProfileSchema.safeParse(body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', result.error.flatten());
  }

  const updates = { ...result.data };

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
    user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true });
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
