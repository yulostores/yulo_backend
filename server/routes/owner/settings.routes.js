import { Router } from 'express';
import { z } from 'zod';
import { uploadFields } from '../../middleware/upload.js';
import { validate } from '../../middleware/validate.js';
import { getSettings, updateSettings, getHours, updateHours, getDelivery, updateDelivery } from '../../controllers/owner/settings.controller.js';

const router = Router({ mergeParams: true });

// Optional logo + banner in a single multipart request. Shared middleware so an
// unsupported format or an oversized file answers 400 (INVALID_FILE_TYPE /
// LIMIT_FILE_SIZE via errorHandler) instead of being dropped on the floor behind a 200.
const brandUpload = uploadFields(['logo', 'banner'], 5);

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
        day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
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
const deliverySchema = z
  .object({
    radiusKm: z.number().min(0).max(100).optional(),
    baseCharge: z.number().min(0).optional(),
    freeThreshold: z.number().min(0).optional(),
    estimatedMinutes: z.number().int().min(0).max(24 * 60).optional(),
  })
  .strict();

router.get('/', getSettings);
router.patch('/', brandUpload, updateSettings);
router.get('/hours', getHours);
router.patch('/hours', validate(operatingHoursSchema), updateHours);
router.get('/delivery', getDelivery);
router.patch('/delivery', validate(deliverySchema), updateDelivery);

export default router;
