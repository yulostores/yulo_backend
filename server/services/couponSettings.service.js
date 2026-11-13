import { z } from 'zod';
import CouponSettings from '../models/CouponSettings.js';
import { COUPON_VALIDITY_DAYS, SEED_COUPON_SETTINGS } from '../config/coupon.config.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// The one source of truth for every coupon rule (models/CouponSettings.js). Callers ask for the
// active version with getActiveCouponSettings() and read the field they need; nothing else
// should hold a coupon count, validity, radius or SMS price of its own.

// Units of each field, served with the values so the admin portal can label them.
export const COUPON_SETTINGS_UNITS = {
  perOrderCap: 'coupons per order',
  minOrderValuePaise: 'paise',
  defaultValidityDays: 'days',
  radiusKm: 'km',
  reminderLeadDays: 'days before expiry',
  smsPricePaise: 'paise per SMS (GST-exclusive)',
  smsGstPercent: 'percent',
  smsCreditPackSizes: 'SMS credits per pack',
  agreementVersion: 'integer (0 = none published)',
  agreementText: 'text',
  phoneCheckRequired: 'yes / no — last 4 phone digits needed to redeem',
};

// ── Validation ────────────────────────────────────────────────────────────────
// Ranges catch typos (a 3,000-day validity, ₹300 per SMS entered as paise ×100), not business
// rules.

const int = (min, max) => z.number().int('must be a whole number').min(min).max(max);

const fieldShape = {
  perOrderCap: int(1, 20),
  minOrderValuePaise: int(0, 10_000_000), // ≤ ₹1,00,000
  // Fixed at 30 days (COUPON_VALIDITY_DAYS): any other value is refused.
  defaultValidityDays: z.literal(COUPON_VALIDITY_DAYS, { message: `Coupon validity is fixed at ${COUPON_VALIDITY_DAYS} days` }),
  radiusKm: z.number().positive().max(200),
  reminderLeadDays: int(1, 30),
  smsPricePaise: int(1, 10_000), // ≤ ₹100 per SMS
  smsGstPercent: z.number().min(0).max(28),
  smsCreditPackSizes: z
    .array(int(1, 1_000_000))
    .min(1)
    .max(10)
    .refine((sizes) => new Set(sizes).size === sizes.length, 'pack sizes must be different'),
  agreementVersion: int(0, 100_000),
  agreementText: z.string().max(100_000),
  phoneCheckRequired: z.boolean(),
};

export const couponSettingsSchema = z.object(fieldShape).strict();
export const couponSettingsPatchSchema = z.object(fieldShape).partial().strict();

const SETTING_KEYS = Object.keys(fieldShape);
// A version saved before a field existed (phoneCheckRequired, CB7) reads as the seed default for
// it, so the next version still validates as a complete rule set.
const pickSettings = (doc) => ({
  ...Object.fromEntries(SETTING_KEYS.map((k) => [k, doc[k] ?? SEED_COUPON_SETTINGS[k]])),
  defaultValidityDays: COUPON_VALIDITY_DAYS, // a version saved before validity was fixed still reads 30
});

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && !Object.isFrozen(value)) Object.freeze(value);
  }
  return Object.freeze(obj);
};

// ── Reads ─────────────────────────────────────────────────────────────────────

// Process-local, like the finance settings cache: settings must resolve with Redis down, and
// every instance re-reads within a minute of a change made on another.
const CACHE_MS = 60_000;
let cache = null; // { settings, expiresAt }

export const __resetCouponSettingsCache = () => {
  cache = null;
};

const findLatest = () => CouponSettings.findOne().sort({ version: -1 }).lean();

// Version 1 from the seed values. Two instances seeding at once collide on the unique version
// index and the loser reads the winner's row — once the index exists, hence init() first.
const seedIfEmpty = async () => {
  await CouponSettings.init().catch((err) =>
    logger.error({ err }, 'Coupon settings indexes could not be built — check for duplicate versions')
  );
  try {
    await CouponSettings.create({ version: 1, note: 'Defaults seeded by the system', ...SEED_COUPON_SETTINGS });
    logger.info('Coupon settings seeded with defaults (version 1)');
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
};

const latestOrSeed = async () => {
  let latest = await findLatest();
  if (!latest) {
    await seedIfEmpty();
    latest = await findLatest();
  }
  if (!latest) throw new ApiError(500, 'COUPON_SETTINGS_MISSING', 'No coupon settings are in effect');
  return latest;
};

/** The rules in force now — a frozen plain object with every field plus `_id`, `version`. */
export const getActiveCouponSettings = async () => {
  if (cache && cache.expiresAt > Date.now()) return cache.settings;
  const settings = deepFreeze(await latestOrSeed());
  cache = { settings, expiresAt: Date.now() + CACHE_MS };
  return settings;
};

/** Every version, newest first — the history table in the admin portal. */
export const listCouponSettingsVersions = () => CouponSettings.find().sort({ version: -1 }).lean();

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Saves a new version: `patch` (any subset of the fields) merged onto the latest version and
 * validated as a complete rule set. In force immediately. Returns { version, changes }.
 * Re-reads its base from the database (never the cache) and retries on a version collision,
 * so two admins saving at once can't overwrite each other.
 */
export const createCouponSettingsVersion = async ({ patch, note = '' }, adminId) => {
  const parsedPatch = couponSettingsPatchSchema.safeParse(patch ?? {});
  if (!parsedPatch.success) {
    const flat = parsedPatch.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? 'Invalid coupon settings', flat);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await latestOrSeed();
    const base = pickSettings(latest);
    const merged = couponSettingsSchema.safeParse({ ...base, ...parsedPatch.data });
    if (!merged.success) {
      const flat = merged.error.flatten();
      throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? 'Invalid coupon settings', flat);
    }
    const changes = SETTING_KEYS.filter(
      (key) => JSON.stringify(base[key]) !== JSON.stringify(merged.data[key])
    ).map((field) => ({ field, from: base[field] ?? null, to: merged.data[field] }));
    if (changes.length === 0) throw new ApiError(400, 'NO_CHANGES', 'These values are already in effect');

    try {
      const created = await CouponSettings.create({
        ...merged.data,
        version: latest.version + 1,
        createdBy: adminId ?? null,
        note,
      });
      __resetCouponSettingsCache();
      return { version: created.toObject(), changes };
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new ApiError(409, 'CONCURRENT_UPDATE', 'Another change was saved at the same time — please retry');
};
