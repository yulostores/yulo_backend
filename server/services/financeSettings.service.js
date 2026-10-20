import { z } from 'zod';
import FinanceSettings, { FINANCE_DAYS, FINANCE_FEE_BEARERS } from '../models/FinanceSettings.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { toPaise } from '../utils/money.js';
import { BANK_FILE_FORMAT_IDS } from '../config/bankFileFormats.js';
import logger from '../utils/logger.js';

// The one source of truth for every payment / settlement rate (models/FinanceSettings.js).
// Callers ask for the active version with getActiveSettings() and read the field they need;
// nothing else in the codebase should hold a rate, fee or switch of its own.

// ── Defaults ──────────────────────────────────────────────────────────────────
//
// What version 1 holds on an empty database: the agreed business rules
// (PAYMENT_IMPLEMENTATION_PROMPTS.md § Business rules), except where a legacy env var is
// explicitly set — those were the live values before settings existed, so a deployment that
// had tuned one keeps it. Read once, at seed time; after that the database is authoritative.
const seedDefaults = () => ({
  foodGstPercent: env.CART_TAX_PERCENT ?? 5,
  serviceGstPercent: 18,
  customerPlatformFee: env.CART_PLATFORM_FEE !== undefined ? toPaise(env.CART_PLATFORM_FEE) : 1200,
  dineInPlatformFeeUnit: 'bill',
  deliveryPerKmRate: 800,
  deliveryMinCharge: 0,
  deliveryDistanceRounding: 0.1,
  settlementChargePercent: 3.5,
  settlementChargeBase: 'customer_total',
  codEnabled: env.COD_ENABLED ?? false,
  riderBasePay:
    env.DELIVERY_PARTNER_PER_DELIVERY_RATE !== undefined ? toPaise(env.DELIVERY_PARTNER_PER_DELIVERY_RATE) : 2000,
  riderBaseKm: 2,
  riderPerKmRate: env.DELIVERY_PARTNER_PER_KM_RATE !== undefined ? toPaise(env.DELIVERY_PARTNER_PER_KM_RATE) : 500,
  settlementCycle: { weekStartsOn: 'monday', timezone: 'Asia/Kolkata' },
  payoutDayOfWeek: 'wednesday',
  carryForwardNegative: true,
  payoutProvider: 'manual',
  payoutBankFileFormat: 'generic_csv',
  refundFeeBorneBy: {
    restaurant_reject: 'restaurant',
    approval_timeout: 'restaurant',
    customer_cancel_before_accept: 'restaurant',
    restaurant_cancel_after_accept: 'restaurant',
  },
  customerCancelAfterPreparationRefundPercent: 0,
});

// Units of each field, served alongside the values so the admin portal can label and convert
// them without its own copy of this knowledge.
export const FINANCE_SETTINGS_UNITS = {
  foodGstPercent: 'percent',
  serviceGstPercent: 'percent',
  customerPlatformFee: 'paise (GST-inclusive)',
  dineInPlatformFeeUnit: 'enum',
  deliveryPerKmRate: 'paise per km (GST-exclusive)',
  deliveryMinCharge: 'paise (GST-exclusive)',
  deliveryDistanceRounding: 'km',
  settlementChargePercent: 'percent (GST-inclusive)',
  settlementChargeBase: 'enum',
  codEnabled: 'boolean',
  riderBasePay: 'paise',
  riderBaseKm: 'km',
  riderPerKmRate: 'paise per km',
  settlementCycle: 'object',
  payoutDayOfWeek: 'enum',
  carryForwardNegative: 'boolean',
  payoutProvider: 'enum',
  payoutBankFileFormat: 'enum (config/bankFileFormats.js)',
  refundFeeBorneBy: 'object',
  customerCancelAfterPreparationRefundPercent: 'percent',
};

// ── Validation ────────────────────────────────────────────────────────────────
//
// Ranges are "sane", not business rules: they exist to catch a typo (a ₹1,200 platform fee
// entered as 120000 rupees-as-paise, a 35 % settlement charge) before it reaches customers.

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const percent = (max) => z.number().min(0).max(max);
const paise = (max) => z.number().int('must be a whole number of paise').min(0).max(max);
const day = z.enum(FINANCE_DAYS);
const bearer = z.enum(FINANCE_FEE_BEARERS);

const cycleSchema = z.object({
  weekStartsOn: day,
  timezone: z.string().refine(isTimeZone, 'must be an IANA time zone, e.g. Asia/Kolkata'),
}).strict();

const bearersSchema = z.object({
  restaurant_reject: bearer,
  approval_timeout: bearer,
  customer_cancel_before_accept: bearer,
  restaurant_cancel_after_accept: bearer,
}).strict();

const fieldShape = {
  foodGstPercent: percent(28),
  serviceGstPercent: percent(28),
  customerPlatformFee: paise(100_000), // ≤ ₹1,000
  dineInPlatformFeeUnit: z.enum(['bill', 'order']),
  deliveryPerKmRate: paise(10_000), // ≤ ₹100 per km
  deliveryMinCharge: paise(100_000),
  deliveryDistanceRounding: z.number().positive().max(5),
  settlementChargePercent: percent(50),
  settlementChargeBase: z.enum(['customer_total', 'restaurant_share']),
  codEnabled: z.boolean(),
  riderBasePay: paise(100_000),
  riderBaseKm: z.number().min(0).max(50),
  riderPerKmRate: paise(10_000),
  settlementCycle: cycleSchema,
  payoutDayOfWeek: day,
  carryForwardNegative: z.boolean(),
  payoutProvider: z.enum(['manual', 'bank_file', 'razorpayx', 'route']),
  // .default so a version saved before this field existed still validates when merged.
  payoutBankFileFormat: z.enum(BANK_FILE_FORMAT_IDS).default('generic_csv'),
  refundFeeBorneBy: bearersSchema,
  // Fixed at 0 for now: a partial refund would also have to shrink the restaurant's credit for
  // the cancelled order, and that rule hasn't been decided. Widen this once it has (and teach
  // services/refund.service.js to refund the percentage).
  customerCancelAfterPreparationRefundPercent: z.literal(0, {
    error: 'Partial refunds after preparation are not supported yet — must be 0',
  }),
};

// A complete, valid rule set — what every stored version must satisfy.
export const financeSettingsSchema = z.object(fieldShape).strict();

// What an admin sends: any subset of the fields (nested objects may be partial too). Merged
// onto the active version before being validated as a whole.
export const financeSettingsPatchSchema = z
  .object({
    ...fieldShape,
    settlementCycle: cycleSchema.partial(),
    refundFeeBorneBy: bearersSchema.partial(),
    // No .default here: in a patch an absent field means "unchanged", and a default would
    // silently switch the payout file format back on every unrelated edit.
    payoutBankFileFormat: z.enum(BANK_FILE_FORMAT_IDS),
  })
  .partial()
  .strict();

const SETTING_KEYS = Object.keys(fieldShape);
const NESTED_KEYS = new Set(['settlementCycle', 'refundFeeBorneBy']);

const pickSettings = (doc) => Object.fromEntries(SETTING_KEYS.map((k) => [k, doc[k]]));

// Plain objects/arrays only — an ObjectId or Date is left alone (an ObjectId holds a Buffer,
// which cannot be frozen).
const isPlain = (value) =>
  Array.isArray(value) || (value !== null && Object.getPrototypeOf(value) === Object.prototype);

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) {
    if (isPlain(value) && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
};

// ── Reads ─────────────────────────────────────────────────────────────────────

// Process-local cache of the CURRENT version. Deliberately not Redis: settings must resolve
// when Redis is down, and every instance re-reads within 60 s of a change anyway. The cache
// also expires the moment a scheduled (future-dated) version becomes active, so a change set
// for midnight takes effect at midnight, not up to a minute later.
const CACHE_MS = 60_000;
let cache = null; // { settings, expiresAt }

export const __resetFinanceSettingsCache = () => {
  cache = null;
};

const findActiveAt = (when) =>
  FinanceSettings.findOne({ effectiveFrom: { $lte: when } }).sort({ effectiveFrom: -1, version: -1 }).lean();

// Version 1 from the defaults, effective since the epoch so it always covers "now" and any
// historical lookup. Two instances seeding at once collide on the unique version index; the
// loser simply reads the winner's row. That only holds once the index exists: on a fresh
// database it is still being built when the first requests arrive, so wait for it (init()
// resolves when this model's indexes are built) — otherwise concurrent first boots each insert
// a version 1, and the unique index can then never be built at all.
const seedIfEmpty = async () => {
  await FinanceSettings.init().catch((err) =>
    logger.error({ err }, 'Finance settings indexes could not be built — check for duplicate versions')
  );
  try {
    await FinanceSettings.create({
      version: 1,
      effectiveFrom: new Date(0),
      note: 'Defaults seeded by the system',
      ...seedDefaults(),
    });
    logger.info('Finance settings seeded with defaults (version 1)');
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
};

/**
 * The rules in force at `at` (default: now) — a frozen plain object with every
 * FinanceSettings field plus `_id`, `version`, `effectiveFrom`. Pass `at` to price or
 * explain something that happened in the past; only "now" is cached.
 */
export const getActiveSettings = async (at) => {
  const nowLookup = at === undefined;
  if (nowLookup && cache && cache.expiresAt > Date.now()) return cache.settings;

  const when = at ?? new Date();
  let active = await findActiveAt(when);
  if (!active) {
    await seedIfEmpty();
    active = await findActiveAt(when);
  }
  if (!active) {
    // Only reachable if someone inserted versions all dated in the future by hand.
    throw new ApiError(500, 'FINANCE_SETTINGS_MISSING', 'No finance settings are in effect');
  }

  const settings = deepFreeze(active);
  if (nowLookup) {
    const next = await FinanceSettings.findOne({ effectiveFrom: { $gt: when } })
      .sort({ effectiveFrom: 1 })
      .select('effectiveFrom')
      .lean();
    const expiresAt = Math.min(Date.now() + CACHE_MS, next ? next.effectiveFrom.getTime() : Infinity);
    cache = { settings, expiresAt };
  }
  return settings;
};

/** Every version, newest first — the history table in the admin portal. */
export const listVersions = () => FinanceSettings.find().sort({ version: -1 }).lean();

/** Versions saved with an effectiveFrom still in the future. */
export const listUpcomingVersions = () =>
  FinanceSettings.find({ effectiveFrom: { $gt: new Date() } }).sort({ effectiveFrom: 1 }).lean();

// ── Writes ────────────────────────────────────────────────────────────────────

// How far in the past an effectiveFrom may be and still count as "now" — absorbs clock skew
// between the admin's browser and the server. Anything older would be a backdated change,
// rewriting how already-placed orders should have been priced, and is refused.
const BACKDATE_TOLERANCE_MS = 5 * 60_000;

const diffSettings = (before, after) => {
  const changes = [];
  for (const key of SETTING_KEYS) {
    if (NESTED_KEYS.has(key)) {
      for (const sub of Object.keys(after[key])) {
        if (before[key]?.[sub] !== after[key][sub]) {
          changes.push({ field: `${key}.${sub}`, from: before[key]?.[sub] ?? null, to: after[key][sub] });
        }
      }
    } else if (before[key] !== after[key]) {
      changes.push({ field: key, from: before[key] ?? null, to: after[key] });
    }
  }
  return changes;
};

// The newest version in effect at `when`, read from the database — never the per-process cache,
// which may be up to a minute behind another instance's save.
const activeAtUncached = async (when) => {
  let active = await findActiveAt(when);
  if (!active) {
    await seedIfEmpty();
    active = await findActiveAt(when);
  }
  if (!active) throw new ApiError(500, 'FINANCE_SETTINGS_MISSING', 'No finance settings are in effect');
  return active;
};

const mergePatch = (base, patch) => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = NESTED_KEYS.has(key) ? { ...base[key], ...value } : value;
  }
  const full = financeSettingsSchema.safeParse(merged);
  if (!full.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid finance settings', full.error.flatten());
  }
  return full.data;
};

// Reads / writes one field of a settings object by its change path ('codEnabled',
// 'settlementCycle.timezone').
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const samePath = (a, b, path) => JSON.stringify(getPath(a, path) ?? null) === JSON.stringify(getPath(b, path) ?? null);

/** The patch that sets just `fields` (change paths) to their values in `full`. */
const patchOf = (full, fields) => {
  const patch = {};
  for (const path of fields) {
    const [key, sub] = path.split('.');
    if (sub) patch[key] = { ...(patch[key] ?? {}), [sub]: full[key][sub] };
    else patch[key] = full[key];
  }
  return patch;
};

/**
 * Saves a new version: `patch` (any subset of the fields) merged onto the version in effect at
 * `effectiveFrom` (default now; may be in the future, never in the past), validated as a
 * complete rule set. Returns { version, changes, reappliedTo }.
 *
 * Versions already scheduled AFTER `effectiveFrom` would otherwise win from their own date
 * and silently undo this change (they were built before it existed), so the change is
 * re-applied to each of them as a new version at that same date: a rider-pay change made
 * today survives a platform-fee change scheduled for next week. Only the fields that actually
 * changed are carried, and only into versions that left that field as they found it — a field
 * a later version changes itself is that version's decision, and from its date on the earlier
 * change stops (`reappliedTo[].skippedFields`). A later version with nothing left to carry gets
 * no new version. Each attempt re-reads its base from the database, so two admins saving at once
 * can't overwrite each other.
 */
export const createVersion = async ({ patch, effectiveFrom, note = '' }, adminId) => {
  const parsedPatch = financeSettingsPatchSchema.safeParse(patch ?? {});
  if (!parsedPatch.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid finance settings', parsedPatch.error.flatten());
  }

  const when = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(when.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'effectiveFrom must be a valid date');
  }
  if (when.getTime() < Date.now() - BACKDATE_TOLERANCE_MS) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'effectiveFrom cannot be in the past — changes apply from now or later');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = pickSettings(await activeAtUncached(when));
    const full = mergePatch(base, parsedPatch.data);
    const changes = diffSettings(base, full);
    if (changes.length === 0) {
      throw new ApiError(400, 'NO_CHANGES', 'These values are already in effect');
    }

    // The newest version at each later scheduled date, oldest date first.
    const later = await FinanceSettings.aggregate([
      { $match: { effectiveFrom: { $gt: when } } },
      { $sort: { effectiveFrom: 1, version: -1 } },
      { $group: { _id: '$effectiveFrom', doc: { $first: '$$ROOT' } } },
      { $sort: { _id: 1 } },
    ]);

    const latest = await FinanceSettings.findOne().sort({ version: -1 }).select('version').lean();
    let nextVersion = (latest?.version ?? 0) + 1;
    const rows = [{ ...full, version: nextVersion, effectiveFrom: when, createdBy: adminId ?? null, note }];
    const reapplied = [];

    // Walk the scheduled versions in date order. Each one was built on the version before it
    // (`previous`, as it was before this save); a field it left unchanged inherits this change,
    // a field it changed itself ends this change's reach from its date on.
    let carrying = changes.map((c) => c.field);
    let previous = base;
    for (const { doc } of later) {
      if (carrying.length === 0) break;
      const original = pickSettings(doc);
      const kept = carrying.filter((field) => samePath(original, previous, field));
      const skippedFields = carrying.filter((field) => !kept.includes(field));
      carrying = kept;
      previous = original;
      if (kept.length === 0) {
        reapplied.push({ scheduledVersion: doc.version, effectiveFrom: doc.effectiveFrom, version: null, fields: [], skippedFields });
        continue;
      }
      nextVersion += 1;
      rows.push({
        ...mergePatch(original, patchOf(full, kept)),
        version: nextVersion,
        effectiveFrom: doc.effectiveFrom,
        createdBy: adminId ?? null,
        note: `${note ? `${note} — ` : ''}re-applied onto the change scheduled for this date (v${doc.version})`,
      });
      reapplied.push({ scheduledVersion: doc.version, effectiveFrom: doc.effectiveFrom, version: nextVersion, fields: kept, skippedFields });
    }

    try {
      // Ordered: a version-number collision fails on the first row, before anything is saved.
      const created = await FinanceSettings.insertMany(rows, { ordered: true });
      __resetFinanceSettingsCache();
      return { version: created[0].toObject(), changes, reappliedTo: reapplied };
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new ApiError(409, 'CONCURRENT_UPDATE', 'Another change was saved at the same time — please retry');
};
