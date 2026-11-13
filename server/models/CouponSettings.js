import mongoose from 'mongoose';

// The coupon system's rules — how many coupons an order earns, validity, seller radius,
// reminder timing, SMS price, the partner agreement — as an append-only history of versions,
// the same discipline as FinanceSettings: a version is never edited, a change is a new version,
// and the active rules are the highest version. Unlike FinanceSettings there is no scheduling:
// a new version takes effect when it is saved.
//
// services/couponSettings.service.js is the only writer; the hooks below refuse in-place
// updates and deletes from anywhere else.
//
// Units: money in integer PAISE, percentages as percent numbers, distances in km.

const couponSettingsSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },

    perOrderCap: { type: Number, required: true },
    minOrderValuePaise: { type: Number, required: true },
    defaultValidityDays: { type: Number, required: true },
    radiusKm: { type: Number, required: true },
    reminderLeadDays: { type: Number, required: true },
    smsPricePaise: { type: Number, required: true },
    smsGstPercent: { type: Number, required: true },
    smsCreditPackSizes: { type: [Number], required: true },
    agreementVersion: { type: Number, required: true },
    agreementText: { type: String, default: '' },
    phoneCheckRequired: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

couponSettingsSchema.index({ version: 1 }, { unique: true });

const refuse = function refuseMutation(next) {
  next(new Error('CouponSettings versions are immutable — create a new version instead'));
};
couponSettingsSchema.pre('save', function blockResave(next) {
  if (!this.isNew) return refuse(next);
  next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  couponSettingsSchema.pre(op, refuse);
}

export default mongoose.model('CouponSettings', couponSettingsSchema);
