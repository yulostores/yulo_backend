import mongoose from 'mongoose';
import { z } from 'zod';
import Coupon from '../models/Coupon.js';
import Seller from '../models/Seller.js';
import User from '../models/User.js';
import SmsCampaign from '../models/SmsCampaign.js';
import SmsLog from '../models/SmsLog.js';
import { getActiveCouponSettings } from './couponSettings.service.js';
import { debitOne, refundOne } from './smsCredits.service.js';
import { logActivity } from './activityLog.service.js';
import { sendTemplate, reminderTemplateId } from './sms/templateSender.js';
import { toSellerCouponView, maskName, istMidnight, istDateSchema } from './sellerReports.service.js';
import { smsCost } from '../utils/couponPricing.js';
import { toRupees } from '../utils/money.js';
import { maskPhone } from '../utils/maskPhone.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';

// Coupon expiry and expiry-reminder SMS (§ CB10). Run by jobs/couponScheduler.js.
//
// Expiry: issued coupons past their date become 'expired' (one updateMany — idempotent).
//
// Reminders go to customers whose coupon expires within CouponSettings.reminderLeadDays:
//   seller reminders  automatic, daily, for every active seller with credits — 1 credit per SMS,
//                     each coupon reminded once (ever) by its seller. One campaign per seller per
//                     day (SmsCampaign.runKey).
//   admin campaigns   a super admin picks the coupons (category, seller, expiry window), previews
//                     count and cost, and queues it; Yulo pays, no credits involved.
//
// Never twice, never below zero: each SMS first claims its SmsLog row — unique per (campaign,
// coupon) — and only then takes a credit with a guarded decrement; a send that fails gives the
// credit back. A seller who runs out simply stops until they buy more. The customer's phone is
// read at send time and never leaves this file unmasked (except to the SMS provider).

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

export const istDay = (at = new Date()) => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (ymd, days) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const prettyDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

// ── Expiry ────────────────────────────────────────────────────────────────────

/** issued → expired for everything past its date. Returns how many changed. */
export const expireDue = async (now = new Date()) => {
  const res = await Coupon.updateMany({ status: 'issued', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });
  return res.modifiedCount;
};

// ── Sending one ───────────────────────────────────────────────────────────────

const phonesOf = async (coupons) => {
  const users = await User.find({ _id: { $in: coupons.map((c) => c.customerId).filter(Boolean) } }).select('phone').lean();
  return new Map(users.filter((u) => /^\d{10}$/.test(u.phone ?? '')).map((u) => [String(u._id), u.phone]));
};

/**
 * One reminder. Returns 'sent' | 'failed' | 'duplicate' (already handled in this campaign) |
 * 'no_credits' (nothing claimed — the seller's balance is empty).
 */
const sendOne = async ({ campaign, coupon, phone, sellerName, chargeSellerId }) => {
  const templateId = reminderTemplateId();
  let log;
  try {
    log = await SmsLog.create({ campaignId: campaign._id, couponId: coupon._id, sellerId: coupon.sellerId, phone, templateId, status: 'queued' });
  } catch (err) {
    if (err?.code === 11000) return 'duplicate';
    throw err;
  }
  if (chargeSellerId && !(await debitOne(chargeSellerId))) {
    await SmsLog.deleteOne({ _id: log._id, status: 'queued' }); // free the slot for when they top up
    return 'no_credits';
  }
  try {
    const { messageId } = await sendTemplate(phone, templateId, { business: sellerName, expiry: prettyDate(coupon.expiresAt) });
    const at = new Date();
    await Promise.all([
      SmsLog.updateOne({ _id: log._id }, { $set: { status: 'sent', providerMessageId: messageId, sentAt: at } }),
      Coupon.updateOne({ _id: coupon._id }, { $push: { remindersSent: { at, campaignId: campaign._id } } }),
      SmsCampaign.updateOne({ _id: campaign._id }, { $inc: { 'counts.sent': 1 } }),
    ]);
    return 'sent';
  } catch (err) {
    logger.warn({ campaignId: campaign._id, couponId: coupon._id, to: maskPhone(phone), err: { code: err?.code, message: err?.message } }, 'Reminder SMS failed');
    await Promise.all([
      SmsLog.updateOne({ _id: log._id }, { $set: { status: 'failed', error: String(err?.code ?? err?.message ?? 'send failed').slice(0, 200) } }),
      SmsCampaign.updateOne({ _id: campaign._id }, { $inc: { 'counts.failed': 1 } }),
      chargeSellerId ? refundOne(chargeSellerId) : null,
    ]);
    return 'failed';
  }
};

// ── Seller reminders ──────────────────────────────────────────────────────────

const reminderWindow = (now, settings) => ({ $gt: now, $lte: new Date(now.getTime() + settings.reminderLeadDays * DAY_MS) });

/** A seller's coupons due a reminder now: issued, expiring within the lead time, never reminded. */
const sellerDue = (sellerId, now, settings) => ({
  sellerId: oid(sellerId),
  kind: 'customer',
  status: 'issued',
  customerId: { $ne: null },
  expiresAt: reminderWindow(now, settings),
  'remindersSent.0': { $exists: false },
});

const sellerCampaignFor = async (seller, now, settings) => {
  const runKey = `seller:${seller._id}:${istDay(now)}`;
  try {
    return await SmsCampaign.findOneAndUpdate(
      { runKey },
      {
        $setOnInsert: {
          runKey,
          sellerId: seller._id,
          createdBy: { kind: 'system', id: null },
          filters: { automatic: true, reminderLeadDays: settings.reminderLeadDays, day: istDay(now) },
          unitPricePaise: settings.smsPricePaise,
          gstPercent: settings.smsGstPercent,
          status: 'sending',
          startedAt: now,
        },
      },
      { upsert: true, new: true }
    ).lean();
  } catch (err) {
    if (err?.code === 11000) return SmsCampaign.findOne({ runKey }).lean(); // the other instance made it
    throw err;
  }
};

/** One seller's reminders for today, until their credits run out. */
export const remindForSeller = async (seller, now, settings) => {
  const coupons = await Coupon.find(sellerDue(seller._id, now, settings)).sort({ expiresAt: 1, _id: 1 }).limit(5000).select('sellerId customerId expiresAt').lean();
  if (coupons.length === 0) return { sent: 0, failed: 0, stoppedForCredits: false };
  const campaign = await sellerCampaignFor(seller, now, settings);
  const phones = await phonesOf(coupons);
  const tally = { sent: 0, failed: 0, stoppedForCredits: false };
  for (const coupon of coupons) {
    const phone = phones.get(String(coupon.customerId));
    if (!phone) continue;
    const outcome = await sendOne({ campaign, coupon, phone, sellerName: seller.businessName, chargeSellerId: seller._id });
    if (outcome === 'no_credits') {
      tally.stoppedForCredits = true;
      break;
    }
    if (outcome === 'sent') tally.sent += 1;
    if (outcome === 'failed') tally.failed += 1;
  }
  const counts = (await SmsCampaign.findById(campaign._id).select('counts').lean())?.counts ?? { sent: 0, failed: 0 };
  const total = counts.sent + counts.failed;
  const cost = smsCost(counts.sent, settings);
  await SmsCampaign.updateOne(
    { _id: campaign._id },
    { $set: { recipientCount: total, pricePaise: cost.pricePaise, gstPaise: cost.gstPaise, totalPaise: cost.totalPaise, status: 'done', finishedAt: new Date() } }
  );
  return tally;
};

/** Every active seller with credits. */
export const runSellerReminders = async (now = new Date()) => {
  const settings = await getActiveCouponSettings();
  const sellers = await Seller.find({ status: 'active', smsCreditsBalance: { $gte: 1 } }).select('businessName').lean();
  const result = { sellers: 0, sent: 0, failed: 0 };
  for (const seller of sellers) {
    try {
      const t = await remindForSeller(seller, now, settings);
      if (t.sent || t.failed) result.sellers += 1;
      result.sent += t.sent;
      result.failed += t.failed;
    } catch (err) {
      logger.error({ err, sellerId: seller._id }, 'Seller reminders failed');
    }
  }
  return result;
};

// ── Admin campaigns ───────────────────────────────────────────────────────────

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const campaignFilterSchema = z
  .object({
    category: objectId.optional(),
    seller: objectId.optional(),
    expiringFrom: istDateSchema.optional(),
    expiringTo: istDateSchema.optional(),
  })
  .strict()
  .refine((f) => !f.expiringFrom || !f.expiringTo || f.expiringFrom <= f.expiringTo, { message: '`expiringFrom` must not be after `expiringTo`', path: ['expiringFrom'] });

const parseOr400 = (schema, input, message) => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? message, flat);
  }
  return parsed.data;
};

/** Filters with the expiry window made explicit (default: today → today + reminderLeadDays, IST). */
const normaliseFilters = (input, settings, now = new Date()) => {
  const f = parseOr400(campaignFilterSchema, input, 'Invalid campaign filters');
  const from = f.expiringFrom ?? istDay(now);
  const to = f.expiringTo ?? addDays(istDay(now), settings.reminderLeadDays);
  return { ...f, expiringFrom: from, expiringTo: to };
};

const campaignMatch = (f, now) => {
  const match = {
    kind: 'customer',
    status: 'issued',
    customerId: { $ne: null },
    expiresAt: { $gt: now, $gte: istMidnight(f.expiringFrom), $lt: new Date(istMidnight(f.expiringTo).getTime() + DAY_MS) },
  };
  if (f.category) match.categoryId = oid(f.category);
  if (f.seller) match.sellerId = oid(f.seller);
  return match;
};

// Coupons whose customer has a mobile number — the SMS that would actually go.
const countRecipients = async (f, now) => {
  const [r] = await Coupon.aggregate([
    { $match: campaignMatch(f, now) },
    { $lookup: { from: User.collection.name, localField: 'customerId', foreignField: '_id', as: 'u', pipeline: [{ $project: { phone: 1 } }] } },
    { $match: { 'u.phone': { $regex: /^\d{10}$/ } } },
    { $count: 'n' },
  ]);
  return r?.n ?? 0;
};

const money = (cost) => ({ ...cost, total: toRupees(cost.totalPaise) });

/** POST /api/admin/reminder-campaigns/preview — recipients and what they'd cost (₹3.54 each). */
export const previewCampaign = async (body) => {
  const settings = await getActiveCouponSettings();
  const now = new Date();
  const filters = normaliseFilters(body, settings, now);
  const recipientCount = await countRecipients(filters, now);
  return {
    filters,
    recipientCount,
    perSms: money(smsCost(1, settings)),
    cost: money(smsCost(recipientCount, settings)),
  };
};

/** POST /api/admin/reminder-campaigns — created and queued for the next 10:00 IST run. */
export const createCampaign = async (adminId, body) => {
  const preview = await previewCampaign(body);
  if (preview.recipientCount === 0) throw new ApiError(422, 'NO_RECIPIENTS', 'No coupons match these filters');
  const settings = await getActiveCouponSettings();
  const campaign = await SmsCampaign.create({
    sellerId: null,
    createdBy: { kind: 'admin', id: adminId },
    filters: preview.filters,
    recipientCount: preview.recipientCount,
    unitPricePaise: settings.smsPricePaise,
    gstPercent: settings.smsGstPercent,
    pricePaise: preview.cost.pricePaise,
    gstPaise: preview.cost.gstPaise,
    totalPaise: preview.cost.totalPaise,
    status: 'queued',
  });
  await logActivity({
    adminId,
    action: 'REMINDER_CAMPAIGN_QUEUED',
    targetType: 'coupon',
    targetId: campaign._id,
    metadata: { filters: preview.filters, recipientCount: preview.recipientCount, totalPaise: preview.cost.totalPaise },
  });
  return campaignView(campaign.toObject());
};

const campaignView = (c) => ({
  _id: c._id,
  status: c.status,
  filters: c.filters,
  recipientCount: c.recipientCount,
  cost: { unitPricePaise: c.unitPricePaise, gstPercent: c.gstPercent, pricePaise: c.pricePaise, gstPaise: c.gstPaise, totalPaise: c.totalPaise, total: toRupees(c.totalPaise) },
  counts: c.counts,
  createdBy: c.createdBy?.kind ?? null,
  sellerId: c.sellerId ?? null,
  createdAt: c.createdAt,
  startedAt: c.startedAt,
  finishedAt: c.finishedAt,
});

/** GET /api/admin/reminder-campaigns?type=admin|seller&page&limit */
export const listCampaigns = async ({ type, page = 1, limit = 20 } = {}) => {
  const filter = type === 'seller' ? { sellerId: { $ne: null } } : type === 'admin' ? { sellerId: null } : {};
  const [rows, total] = await Promise.all([
    SmsCampaign.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SmsCampaign.countDocuments(filter),
  ]);
  return { campaigns: rows.map(campaignView), total, page, limit };
};

/** GET /api/admin/reminder-campaigns/:id — counts and the log, phones masked. */
export const campaignDetail = async (id, { page = 1, limit = 50 } = {}) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  const campaign = await SmsCampaign.findById(id).lean();
  if (!campaign) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
  const [logs, total, byStatus] = await Promise.all([
    SmsLog.find({ campaignId: campaign._id }).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    SmsLog.countDocuments({ campaignId: campaign._id }),
    SmsLog.aggregate([{ $match: { campaignId: campaign._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  return {
    campaign: campaignView(campaign),
    logCounts: Object.fromEntries(['queued', 'sent', 'failed'].map((s) => [s, byStatus.find((b) => b._id === s)?.n ?? 0])),
    log: logs.map((l) => ({ couponId: l.couponId, phone: maskPhone(l.phone), status: l.status, error: l.error, sentAt: l.sentAt })),
    total,
    page,
    limit,
  };
};

/** Sends every queued admin campaign (and resumes one a crash left 'sending'). */
export const runAdminCampaigns = async (now = new Date()) => {
  const result = { campaigns: 0, sent: 0, failed: 0 };
  for (;;) {
    // Claim one at a time; 'sending' ones are resumed (their logs make re-sending impossible).
    const campaign =
      (await SmsCampaign.findOneAndUpdate(
        { sellerId: null, status: 'queued' },
        { $set: { status: 'sending', startedAt: now } },
        { sort: { createdAt: 1 }, new: true }
      ).lean()) ?? (await SmsCampaign.findOne({ sellerId: null, status: 'sending', _id: { $nin: result.done ?? [] } }).sort({ createdAt: 1 }).lean());
    if (!campaign) break;
    (result.done ??= []).push(campaign._id);
    try {
      const sellerNames = new Map();
      const cursor = Coupon.find(campaignMatch(campaign.filters, now)).sort({ expiresAt: 1, _id: 1 }).select('sellerId customerId expiresAt').lean().cursor({ batchSize: 500 });
      let batch = [];
      const flush = async () => {
        const phones = await phonesOf(batch);
        const missing = [...new Set(batch.map((c) => String(c.sellerId)).filter((s) => !sellerNames.has(s)))];
        if (missing.length) for (const s of await Seller.find({ _id: { $in: missing } }).select('businessName').lean()) sellerNames.set(String(s._id), s.businessName);
        for (const coupon of batch) {
          const phone = phones.get(String(coupon.customerId));
          if (!phone) continue;
          const outcome = await sendOne({ campaign, coupon, phone, sellerName: sellerNames.get(String(coupon.sellerId)) ?? 'Yulo partner', chargeSellerId: null });
          if (outcome === 'sent') result.sent += 1;
          if (outcome === 'failed') result.failed += 1;
        }
        batch = [];
      };
      for await (const coupon of cursor) {
        batch.push(coupon);
        if (batch.length >= 500) await flush();
      }
      if (batch.length) await flush();
      await SmsCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'done', finishedAt: new Date() } });
      result.campaigns += 1;
    } catch (err) {
      logger.error({ err, campaignId: campaign._id }, 'Reminder campaign failed — it stays "sending" and resumes next run');
    }
  }
  delete result.done;
  return result;
};

// ── Seller view ───────────────────────────────────────────────────────────────

/**
 * GET /api/seller/reminders — coupons expiring soon (masked, through the seller serializer) and
 * whether each was reminded, the credit balance, and the recent send log. No phone digits at all:
 * even a masked number's last four would defeat the redemption phone check.
 */
export const sellerRemindersView = async (sellerId) => {
  const now = new Date();
  const settings = await getActiveCouponSettings();
  const [seller, coupons, logs] = await Promise.all([
    Seller.findById(sellerId).select('smsCreditsBalance').lean(),
    Coupon.find({ sellerId: oid(sellerId), kind: 'customer', status: 'issued', expiresAt: reminderWindow(now, settings) })
      .sort({ expiresAt: 1 })
      .limit(200)
      .select('customerSnapshot.name customerSnapshot.gender customerSnapshot.dateOfBirth offerSnapshot.title categoryId issuedAt expiresAt status redeemedAt redeemedBy remindersSent')
      .lean(),
    SmsLog.find({ sellerId: oid(sellerId) }).sort({ createdAt: -1 }).limit(50).select('couponId status sentAt createdAt campaignId').lean(),
  ]);
  if (!seller) throw new ApiError(404, 'NOT_FOUND', 'Seller not found');
  const ownCampaigns = new Set(
    (await SmsCampaign.find({ _id: { $in: logs.map((l) => l.campaignId) }, sellerId: oid(sellerId) }).select('_id').lean()).map((c) => String(c._id))
  );
  const names = new Map(
    (await Coupon.find({ _id: { $in: logs.map((l) => l.couponId) } }).select('customerSnapshot.name').lean()).map((c) => [String(c._id), c.customerSnapshot?.name])
  );
  return {
    credits: seller.smsCreditsBalance ?? 0,
    reminderLeadDays: settings.reminderLeadDays,
    perSms: money(smsCost(1, settings)),
    expiringSoon: coupons.map((c) => ({ ...toSellerCouponView(c, { now }), reminded: (c.remindersSent ?? []).length > 0 })),
    // Only the reminders this seller paid for; Yulo's own campaigns are not theirs to see.
    sent: logs
      .filter((l) => ownCampaigns.has(String(l.campaignId)))
      .map((l) => ({ customerName: maskName(names.get(String(l.couponId))), status: l.status, sentAt: l.sentAt ?? null, at: l.createdAt })),
  };
};
