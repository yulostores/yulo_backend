import { Router } from 'express';
import { z } from 'zod';
import { uploadFields } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { getSettings, updateSettings, getHours, updateHours, getDelivery, updateDelivery } from '../../controllers/owner/settings.controller.js';
import {
  BRAND_IMAGE_FIELDS,
  BRAND_IMAGE_MAX_MB,
  DAYS,
  DELIVERY_FIELDS,
} from '../../config/storeSettings.config.js';

const router = Router({ mergeParams: true });

// Optional logo + banner in a single multipart request. Shared middleware so an
// unsupported format or an oversized file answers 400 (INVALID_FILE_TYPE /
// LIMIT_FILE_SIZE via errorHandler) instead of being dropped on the floor behind a 200.
const brandUpload = uploadFields(BRAND_IMAGE_FIELDS, BRAND_IMAGE_MAX_MB);

// Times are HHMM integers (900 = 09:00, 2200 = 22:00) — the same encoding
// models/Restaurant.js stores. Without the range check `openTime: 2599` or a negative
// value writes straight through and every consumer that formats it (the storefront's
// "open until", the owner portal's hours table) renders nonsense.
const hhmmSchema = z
  .number()
  .int()
  .min(0)
  .max(2359)
  .refine((n) => n % 100 <= 59, { message: 'Minutes must be between 00 and 59' });

const operatingHoursSchema = z.object({
  operatingHours: z
    .array(
      z.object({
        day: z.enum(DAYS),
        isOpen: z.boolean().default(true),
        openTime: hhmmSchema,
        closeTime: hhmmSchema,
      })
    )
    // The write replaces the array wholesale, so a duplicate day would leave the
    // restaurant with two conflicting entries for the same weekday.
    .superRefine((hours, ctx) => {
      const days = hours.map((h) => h.day);
      if (new Set(days).size !== days.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each day may appear only once' });
      }
    }),
});

// Every field optional so a caller can send just the one it is changing, but the whole
// object is replaced on write — see the controller.
//
// Built from the same field descriptors the owner portal validates against
// (config/storeSettings.config.js), so a bound can't be tightened in one place and left
// stale in the other — the form would then accept a value this route rejects.
const deliverySchema = z
  .object(
    Object.fromEntries(
      DELIVERY_FIELDS.map((field) => {
        let schema = z.number();
        if (field.integer) schema = schema.int();
        if (field.min !== undefined) schema = schema.min(field.min);
        if (field.max !== undefined) schema = schema.max(field.max);
        return [field.path.split('.').pop(), schema.optional()];
      })
    )
  )
  .strict();

router.get('/', getSettings);
router.patch('/', brandUpload, updateSettings);
router.get('/hours', getHours);
router.patch('/hours', validate(operatingHoursSchema), updateHours);
router.get('/delivery', getDelivery);
router.patch('/delivery', validate(deliverySchema), updateDelivery);

export default router;
