// Moves an existing database to the GST rates agreed in Nov 2026: only the platform fee carries
// 18 % GST; everything else Yulo charges is 5 % — the delivery charge and settlement charge
// (Finance settings → serviceGstPercent), the seller coupon plans (CouponPlan.gstPercent) and SMS
// credits (Coupon settings → smsGstPercent). Food GST is the restaurant's own (5 %) and untouched.
//
//   node scripts/applyGstRates.js                                  # dry run: shows what changes
//   node scripts/applyGstRates.js --apply --confirm <dbName>       # really change it
//
// Finance and coupon settings get a NEW version (history kept, effective now), exactly as if an
// admin saved them in the portal. Plans are edited in place; a plan already bought keeps the GST
// frozen on its purchase. Safe to run twice: anything already at the new rate is left alone.

import 'dotenv/config';
import mongoose from 'mongoose';

import CouponPlan from '../models/CouponPlan.js';
import User from '../models/User.js';
import { createVersion, getActiveSettings, __resetFinanceSettingsCache } from '../services/financeSettings.service.js';
import { createCouponSettingsVersion, getActiveCouponSettings, __resetCouponSettingsCache } from '../services/couponSettings.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const PLATFORM_FEE_GST = 18;
const OTHER_GST = 5;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmName = confirmIndex !== -1 ? args[confirmIndex + 1] : null;

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`connected to "${dbName}" on ${mongoose.connection.host}`);
  if (apply && confirmName !== dbName) {
    console.error(`\nRefusing to change anything: pass --confirm ${dbName} together with --apply.`);
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'APPLY mode\n' : 'dry run — nothing is changed (pass --apply --confirm <dbName>)\n');

  const finance = await getActiveSettings();
  const coupon = await getActiveCouponSettings();
  const plans = await CouponPlan.find({}).select('key name gstPercent').lean();

  const financePatch = {};
  if (finance.serviceGstPercent !== OTHER_GST) financePatch.serviceGstPercent = OTHER_GST;
  if ((finance.platformFeeGstPercent ?? 18) !== PLATFORM_FEE_GST || finance.platformFeeGstPercent == null) financePatch.platformFeeGstPercent = PLATFORM_FEE_GST;
  console.log(`Finance settings: delivery/settlement GST ${finance.serviceGstPercent}% → ${OTHER_GST}%, platform fee GST ${finance.platformFeeGstPercent ?? 18}% → ${PLATFORM_FEE_GST}%`);
  console.log(`Coupon settings:  SMS credit GST ${coupon.smsGstPercent}% → ${OTHER_GST}%`);
  for (const p of plans) console.log(`Plan ${p.name.padEnd(10)} GST ${p.gstPercent}% → ${OTHER_GST}%`);
  if (!apply) return;

  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
  const adminId = admin?._id ?? new mongoose.Types.ObjectId();
  const note = 'GST: only the platform fee is 18 %; everything else 5 % (scripts/applyGstRates.js)';

  if (Object.keys(financePatch).length) {
    await createVersion({ patch: financePatch, note }, adminId);
    __resetFinanceSettingsCache();
    console.log('✓ finance settings: new version saved');
  } else console.log('· finance settings already at the new rates');

  if (coupon.smsGstPercent !== OTHER_GST) {
    await createCouponSettingsVersion({ patch: { smsGstPercent: OTHER_GST }, note }, adminId);
    __resetCouponSettingsCache();
    console.log('✓ coupon settings: new version saved');
  } else console.log('· coupon settings already at the new rate');

  const { modifiedCount } = await CouponPlan.updateMany({ gstPercent: { $ne: OTHER_GST } }, { $set: { gstPercent: OTHER_GST } });
  console.log(`✓ coupon plans updated: ${modifiedCount}`);

  await recordMigrationRun('applyGstRates', { financePatch, smsGstPercent: OTHER_GST, plansUpdated: modifiedCount });
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
