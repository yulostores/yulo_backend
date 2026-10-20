import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logActivity } from '../../services/activityLog.service.js';
import {
  FINANCE_SETTINGS_UNITS,
  createVersion,
  getActiveSettings,
  listUpcomingVersions,
  listVersions,
} from '../../services/financeSettings.service.js';

// GET /api/admin/finance/settings — the rules in force now, any already-scheduled future
// versions, and the full history. `units` says how to read each field (money is in paise).
export const getSettings = asyncHandler(async (_req, res) => {
  const active = await getActiveSettings();
  const [upcoming, history] = await Promise.all([listUpcomingVersions(), listVersions()]);
  sendSuccess(res, 200, 'Finance settings', { active, upcoming, history, units: FINANCE_SETTINGS_UNITS });
});

// The fields themselves are validated by the service (merged onto the active version, then
// checked as a complete rule set) — this only shapes the envelope.
const createSchema = z
  .object({
    settings: z.record(z.string(), z.any()),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

// POST /api/admin/finance/settings — saves a new version. Body:
//   { settings: { <any subset of fields> }, effectiveFrom?: ISO date-time, note?: string }
// effectiveFrom defaults to now and may be in the future (a scheduled change), never the past.
export const createSettingsVersion = asyncHandler(async (req, res) => {
  const result = createSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error.flatten());
  }
  const { settings, effectiveFrom, note } = result.data;

  const { version, changes, reappliedTo } = await createVersion({ patch: settings, effectiveFrom, note }, req.user._id);

  await logActivity({
    adminId: req.user._id,
    action: 'finance_settings.create_version',
    targetType: 'finance_settings',
    targetId: version._id,
    metadata: { version: version.version, effectiveFrom: version.effectiveFrom, note: version.note, changes, reappliedTo },
  });

  // reappliedTo: already-scheduled later versions the same change was copied onto, so it isn't
  // undone when they take effect.
  sendSuccess(res, 201, 'Finance settings saved', { version, changes, reappliedTo });
});
