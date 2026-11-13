// Seeds the coupon system's reference data: the three partner plans, the business categories
// and Coupon Settings version 1 (config/coupon.config.js).
//
//   node scripts/seedCouponData.js            # shows what would be created, writes nothing
//   node scripts/seedCouponData.js --apply    # creates whatever is missing and prints it
//
// Idempotent and additive: a plan or category that already exists (matched by `key`) is left
// exactly as it is — the super admin may have edited its price or name since — and settings
// are seeded only when no version exists. Re-running never overwrites anything.
//
// Categories are created DISABLED; a super admin switches on the ones customers should receive.

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import CouponPlan from '../models/CouponPlan.js';
import CouponCategory from '../models/CouponCategory.js';
import CouponSettings from '../models/CouponSettings.js';
import { SEED_COUPON_PLANS, SEED_COUPON_CATEGORIES } from '../config/coupon.config.js';
import { getActiveCouponSettings } from '../services/couponSettings.service.js';
import { planTotals } from '../utils/couponPricing.js';
import { recordMigrationRun } from './_migrationLog.js';

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/** Exported for tests. Returns { plansCreated, categoriesCreated, settingsSeeded }. */
export const seedCouponData = async ({ apply = false, log = console.log } = {}) => {
  // Unique indexes on `key` / `version` must exist before inserting, or two concurrent runs on
  // a fresh database could both insert the same row.
  await Promise.all([CouponPlan.init(), CouponCategory.init(), CouponSettings.init()]);

  const existingPlanKeys = new Set((await CouponPlan.find().select('key').lean()).map((p) => p.key));
  const existingCategoryKeys = new Set((await CouponCategory.find().select('key').lean()).map((c) => c.key));
  const settingsCount = await CouponSettings.countDocuments();

  const plans = SEED_COUPON_PLANS.filter((p) => !existingPlanKeys.has(p.key));
  const categories = SEED_COUPON_CATEGORIES.filter((c) => !existingCategoryKeys.has(c.key));

  log('Coupon plans:');
  for (const p of SEED_COUPON_PLANS) {
    const t = planTotals(p);
    const state = existingPlanKeys.has(p.key) ? 'exists — left unchanged' : 'to create';
    log(
      `  ${p.name.padEnd(8)} ${rupees(t.basePaise)} + GST ${rupees(t.gstPaise)} = ${rupees(t.totalPaise)}, ` +
        `${p.couponAllocation} coupons + ${p.complimentaryCount} complimentary  (${state})`
    );
  }
  log('Coupon categories (created disabled):');
  for (const c of SEED_COUPON_CATEGORIES) {
    log(`  ${c.name.padEnd(15)} ${existingCategoryKeys.has(c.key) ? 'exists — left unchanged' : 'to create'}`);
  }
  log(`Coupon settings: ${settingsCount > 0 ? `${settingsCount} version(s) exist — left unchanged` : 'version 1 to create'}`);

  if (!apply) {
    log('Dry run — nothing written. Re-run with --apply to create what is missing.');
    return { plansCreated: 0, categoriesCreated: 0, settingsSeeded: false };
  }

  // insertMany with ordered:false: a row another process created meanwhile fails on its own
  // unique key and the rest still go in.
  const insertMissing = async (Model, rows) => {
    if (rows.length === 0) return 0;
    try {
      return (await Model.insertMany(rows, { ordered: false })).length;
    } catch (err) {
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      return err.insertedDocs?.length ?? 0;
    }
  };
  const plansCreated = await insertMissing(CouponPlan, plans);
  const categoriesCreated = await insertMissing(CouponCategory, categories);
  const settings = await getActiveCouponSettings(); // seeds version 1 if none exists
  const settingsSeeded = settingsCount === 0;

  log(`Created ${plansCreated} plan(s), ${categoriesCreated} categor${categoriesCreated === 1 ? 'y' : 'ies'}.`);
  log(`Coupon settings in force: version ${settings.version}${settingsSeeded ? ' (just seeded)' : ''}.`);
  if (plansCreated || categoriesCreated || settingsSeeded) {
    await recordMigrationRun('seedCouponData', { plansCreated, categoriesCreated, settingsSeeded });
  }
  return { plansCreated, categoriesCreated, settingsSeeded };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => seedCouponData({ apply: process.argv.includes('--apply') }))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
