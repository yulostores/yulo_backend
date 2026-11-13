import mongoose from 'mongoose';
import { SMS_CAMPAIGN_STATUSES } from '../config/coupon.config.js';

// A batch of coupon-expiry reminder SMS. Either a seller's own (paid from its prepaid credits)
// or a Yulo-paid campaign a super admin runs (sellerId null). The price is snapshotted when the
// campaign is created, from CouponSettings.smsPricePaise + smsGstPercent, so a later rate change
// never rewrites what a past campaign cost.

const smsCampaignSchema = new mongoose.Schema(
  {
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', default: null },
    createdBy: {
      kind: { type: String, enum: ['admin', 'seller_user', 'system'], required: true },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    // The filters that chose the recipients (category, seller, expiry window, status), kept for
    // the campaign detail page and the audit trail.
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    recipientCount: { type: Number, default: 0, min: 0 },
    unitPricePaise: { type: Number, required: true, min: 0 },
    gstPercent: { type: Number, required: true, min: 0 },
    pricePaise: { type: Number, default: 0, min: 0 },
    gstPaise: { type: Number, default: 0, min: 0 },
    totalPaise: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: SMS_CAMPAIGN_STATUSES, default: 'draft' },
    counts: {
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    // The scheduler's daily automatic run for a seller: "seller:<sellerId>:<YYYY-MM-DD IST>".
    // Unique, so two instances (or two ticks) create one campaign per seller per day. Admin
    // campaigns have none.
    runKey: { type: String, default: undefined },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

smsCampaignSchema.index({ status: 1, createdAt: 1 });
smsCampaignSchema.index({ sellerId: 1, createdAt: -1 });
smsCampaignSchema.index({ runKey: 1 }, { unique: true, partialFilterExpression: { runKey: { $type: 'string' } } });

export default mongoose.model('SmsCampaign', smsCampaignSchema);
