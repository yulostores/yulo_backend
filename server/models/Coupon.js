import mongoose from 'mongoose';
import { COUPON_KINDS, COUPON_STATUSES, COUPON_SOURCE_TYPES, GENDERS } from '../config/coupon.config.js';

// One coupon — the unit of everything: issue, redemption, expiry and every report.
//
// kind
//   customer       issued to a Yulo customer after a paid food order (or manually by an admin);
//                  drawn from a SellerSubscription's stock.
//   complimentary  the plan's extra coupons reserved for Yulo team members. Created at plan
//                  activation, outside the stock counts. SUPER ADMIN ONLY: every seller and
//                  customer query filters `kind: 'customer'`, and the seller API can never
//                  redeem one (§ Business rules — Visibility).
//
// status: issued → redeemed | expired (daily job) | void (the paying order was refunded).
// Each transition is a single conditional update on `status: 'issued'`, which is what makes a
// coupon impossible to redeem twice.
//
// customerSnapshot is copied at issue so reports keep describing the customer as they were
// then. The phone is deliberately NOT copied: it stays on User and is joined only for super
// admin views and SMS reminders.

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true },
    kind: { type: String, enum: COUPON_KINDS, required: true },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seller', required: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerSubscription', required: true },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponOffer', default: null },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'CouponCategory', required: true },

    // The offer's wording as the customer was given it. A later edit to the offer (which sends
    // it back to review) never changes the terms of a coupon already in someone's hand.
    offerSnapshot: {
      title: { type: String, default: null },
      terms: { type: String, default: null },
    },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerSnapshot: {
      name: { type: String, default: null },
      gender: { type: String, enum: [...GENDERS, null], default: null },
      dateOfBirth: { type: Date, default: null },
    },

    source: {
      type: { type: String, enum: COUPON_SOURCE_TYPES, required: true },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    // "<source type>:<source id>:<category id>" — set only for coupons issued from a paid order
    // or bill. Unique, so the payment webhook and the client's verify call racing on the same
    // payment can never issue a category twice. Absent on complimentary / manual coupons.
    issueKey: { type: String, default: undefined },

    status: { type: String, enum: COUPON_STATUSES, default: 'issued' },
    issuedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    redeemedAt: { type: Date, default: null },
    redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SellerUser', default: null },
    voidedAt: { type: Date, default: null },
    voidReason: { type: String, default: null },

    // Complimentary only: the Yulo team member it was handed to.
    assignedTo: {
      name: { type: String, trim: true, default: null },
      phone: { type: String, trim: true, default: null },
      note: { type: String, trim: true, default: null },
      at: { type: Date, default: null },
    },

    remindersSent: [
      {
        _id: false,
        at: { type: Date, required: true },
        campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'SmsCampaign', default: null },
      },
    ],
  },
  { timestamps: true }
);

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ issueKey: 1 }, { unique: true, partialFilterExpression: { issueKey: { $type: 'string' } } });
// Seller dashboard / reports.
couponSchema.index({ sellerId: 1, kind: 1, status: 1, expiresAt: 1 });
// Daily expiry and reminder jobs.
couponSchema.index({ status: 1, expiresAt: 1 });
// Customer "My Coupons".
couponSchema.index({ customerId: 1, issuedAt: -1 });
// Admin reports by category / date.
couponSchema.index({ categoryId: 1, issuedAt: -1 });
couponSchema.index({ 'source.type': 1, 'source.id': 1 });

export default mongoose.model('Coupon', couponSchema);
