import mongoose from 'mongoose';
import { SMS_LOG_STATUSES } from '../config/coupon.config.js';

// One reminder SMS for one coupon in one campaign. The unique (campaignId, couponId) index is
// the guarantee that a retried or doubled scheduler tick never texts a customer twice.
//
// The phone is stored for delivery and support, but every API response masks it
// (utils/maskPhone.js) — it is never shown in full to anyone but through the admin CSV export.

const smsLogSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmsCampaign', required: true },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', default: null },
    phone: { type: String, required: true },
    templateId: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    status: { type: String, enum: SMS_LOG_STATUSES, default: 'queued' },
    error: { type: String, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

smsLogSchema.index({ campaignId: 1, couponId: 1 }, { unique: true });
smsLogSchema.index({ couponId: 1 });
smsLogSchema.index({ sellerId: 1, createdAt: -1 });

export default mongoose.model('SmsLog', smsLogSchema);
