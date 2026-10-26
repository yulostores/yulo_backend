import { z } from 'zod';
import DeliveryPartner from '../../models/DeliveryPartner.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { EXPO_PUSH_TOKEN } from '../../services/push.service.js';

export const getProfile = asyncHandler(async (req, res) => {
  const partner = await DeliveryPartner.findById(req.partner._id).lean();
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');
  sendSuccess(res, 200, 'Profile', { partner });
});

// Field list matches Notifications.jsx's toggle rows exactly (see the schema comment on
// DeliveryPartner.notificationPreferences).
const notificationPreferencesSchema = z.object({
  orders: z.boolean().optional(),
  payments: z.boolean().optional(),
  promotions: z.boolean().optional(),
  appUpdates: z.boolean().optional(),
  soundVibration: z.boolean().optional(),
});

export const updateNotificationPreferences = asyncHandler(async (req, res) => {
  const result = notificationPreferencesSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid notification preferences', result.error.flatten());
  }

  const data = {};
  for (const [key, value] of Object.entries(result.data)) {
    data[`notificationPreferences.${key}`] = value;
  }

  const partner = await DeliveryPartner.findByIdAndUpdate(req.partner._id, { $set: data }, { new: true });
  if (!partner) throw new ApiError(404, 'NOT_FOUND', 'Delivery partner not found');

  sendSuccess(res, 200, 'Notification preferences updated', {
    notificationPreferences: partner.notificationPreferences,
  });
});

const pushTokenSchema = z.object({
  token: z.string().trim().regex(EXPO_PUSH_TOKEN, 'Not an Expo push token'),
});

// PUT /api/partner/notifications/push-token — the app registers the phone it is running on, so an
// order offer reaches the rider while the app is in the background (services/push.service.js).
// One phone per rider: the latest registration wins. The same phone can't stay registered to a
// rider who signed out of it and handed it to someone else, so the token is taken off any other.
export const registerPushToken = asyncHandler(async (req, res) => {
  const result = pushTokenSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid push token', result.error.flatten());
  }
  const { token } = result.data;
  await DeliveryPartner.updateMany({ pushToken: token, _id: { $ne: req.partner._id } }, { $set: { pushToken: null } });
  await DeliveryPartner.updateOne({ _id: req.partner._id }, { $set: { pushToken: token } });
  sendSuccess(res, 200, 'Push token saved', { registered: true });
});

// DELETE /api/partner/notifications/push-token — signing out: this phone stops getting the
// rider's offers.
export const clearPushToken = asyncHandler(async (req, res) => {
  await DeliveryPartner.updateOne({ _id: req.partner._id }, { $set: { pushToken: null } });
  sendSuccess(res, 200, 'Push token removed', { registered: false });
});
