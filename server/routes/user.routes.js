import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { upload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { isSupportedLanguage } from '../config/appConfig.config.js';
import {
  getMe,
  updateMe,
  addAddress,
  updateAddress,
  setDefaultAddress,
  removeAddress,
  getPreferences,
  updatePreferences,
  registerDevice,
  removeDevice,
} from '../controllers/user.controller.js';
import {
  listFavoriteRestaurants,
  addFavoriteRestaurant,
  removeFavoriteRestaurant,
  addFavoriteItem,
  removeFavoriteItem,
} from '../controllers/favorite.controller.js';

const router = Router();

router.use(authenticate);

const notificationCategorySchema = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
});

const locationSchema = z.object({
  type: z.literal('Point').default('Point'),
  coordinates: z.tuple([z.number(), z.number()]).optional(),
});

// `customLabel` only makes sense (and is only ever persisted) when label === 'other' —
// services/user.service.js clears it server-side whenever label is set back to
// 'home'/'work', but reject it as a validation error up front too when label is present
// and isn't 'other', so a caller gets an explicit 400 instead of a silently dropped field.
const addressCreateSchema = z
  .object({
    label: z.enum(['home', 'work', 'other']).default('home'),
    customLabel: z.string().min(1).max(40).optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    pincode: z.string().optional(),
    location: locationSchema.optional(),
    // Who receives the order here, when that isn't the account holder. Optional — checkout
    // falls back to the account's own name and verified phone.
    contactName: z.string().trim().min(1).max(60).optional(),
    contactPhone: z.string().trim().min(6).max(20).optional(),
    isDefault: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.label === 'other' && !data.customLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customLabel'],
        message: 'customLabel is required when label is "other"',
      });
    }
  });

const addressUpdateSchema = z
  .object({
    label: z.enum(['home', 'work', 'other']).optional(),
    customLabel: z.string().min(1).max(40).optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    pincode: z.string().optional(),
    location: locationSchema.optional(),
    contactName: z.string().trim().min(1).max(60).optional(),
    contactPhone: z.string().trim().min(6).max(20).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' })
  .superRefine((data, ctx) => {
    if (data.label === 'other' && !data.customLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['customLabel'],
        message: 'customLabel is required when label is "other"',
      });
    }
  });

const preferencesUpdateSchema = z
  .object({
    vegModeEnabled: z.boolean().optional(),
    vegModeScope: z.enum(['all_restaurants', 'pure_veg_only']).optional(),
    vegFleetPreferenceEnabled: z.boolean().optional(),
    // Only a language the app actually ships strings for (config/appConfig.config.js →
    // SUPPORTED_LANGUAGES with `available: true`). This keeps the stored code from ever
    // getting ahead of a shipped translation — the picker in the app disables the rest.
    preferredLanguage: z
      .string()
      .min(2)
      .max(10)
      .refine(isSupportedLanguage, { message: 'Unsupported language' })
      .optional(),
    notifications: z
      .object({
        pushEnabled: z.boolean().optional(),
        categories: z.array(notificationCategorySchema).optional(),
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' });

const deviceRegisterSchema = z.object({
  deviceToken: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']),
});

router.get('/me', getMe);
// Optional `avatar` file (2 MB) rides along with the JSON fields. Multer skips any
// request that isn't multipart/form-data, so callers still sending application/json
// (including a `profilePicture`/`avatarUrl` string) are unaffected.
router.patch('/me', upload('avatar', 2), updateMe);
router.post('/me/addresses', validate(addressCreateSchema), addAddress);
router.patch('/me/addresses/:addrId', validate(addressUpdateSchema), updateAddress);
router.patch('/me/addresses/:addrId/default', setDefaultAddress);
router.delete('/me/addresses/:addrId', removeAddress);

router.get('/me/preferences', getPreferences);
router.patch('/me/preferences', validate(preferencesUpdateSchema), updatePreferences);
router.post('/me/devices', validate(deviceRegisterSchema), registerDevice);
router.delete('/me/devices/:deviceToken', removeDevice);

router.get('/me/favorites/restaurants', listFavoriteRestaurants);
router.post('/me/favorites/restaurants/:restaurantId', addFavoriteRestaurant);
router.delete('/me/favorites/restaurants/:restaurantId', removeFavoriteRestaurant);
router.post('/me/favorites/items/:menuItemId', addFavoriteItem);
router.delete('/me/favorites/items/:menuItemId', removeFavoriteItem);

export default router;
