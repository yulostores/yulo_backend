import mongoose from 'mongoose';
import { followUpSchemaFields } from '../services/applicationFollowUp.service.js';
import { PARTNER_APPLICATION_STATUSES, PARTNER_CATEGORIES } from '../config/partnerApplication.config.js';

// A business applying from the careers portal to become a Yulo coupon partner ("Choose your
// business"). Created unpaid (`pending_payment`) with a Razorpay order for the ₹100 form fee; it
// becomes a lead for the partnerships team (`new`, numbered YB-000001) once that payment is
// verified — by the browser's verify call or the Razorpay webhook, whichever lands first
// (services/partnerApplication.service.js). No account: the browser that created it holds a
// random access token (only its SHA-256 is stored) to pay for it.

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    status: { type: String, default: null },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const partnerApplicationSchema = new mongoose.Schema(
  {
    applicationNumber: { type: String, default: null }, // YB-000123, given once paid
    businessName: { type: String, required: true, trim: true },
    category: { type: String, enum: PARTNER_CATEGORIES.map((c) => c.key), required: true },
    otherCategory: { type: String, trim: true, default: null }, // what "Other" is, typed in
    address: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    hasGst: { type: Boolean, required: true },
    employees: { type: Number, required: true, min: 0 },
    ownerName: { type: String, required: true, trim: true },
    phone: { type: String, required: true }, // owner's contact, 10 digits
    alternatePhone: { type: String, default: null },
    questions: { type: String, trim: true, default: null },

    status: { type: String, enum: PARTNER_APPLICATION_STATUSES, default: 'pending_payment' },
    statusChangedAt: { type: Date, default: null },
    notes: { type: [noteSchema], default: [] },

    accessTokenHash: { type: String, required: true, select: false },

    payment: {
      amountPaise: { type: Number, required: true },
      status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
      razorpayOrderId: { type: String, default: null },
      razorpayOrderHistory: { type: [String], default: [] },
      razorpayPaymentId: { type: String, default: null },
      confirmedVia: { type: String, enum: ['verify', 'webhook', 'simulation', null], default: null },
      paidAt: { type: Date, default: null },
    },
    submittedAt: { type: Date, default: null }, // when the fee was paid
    // The super admin's follow-up: called, interested / not, and deleting unpaid entries.
    ...followUpSchemaFields,
  },
  { timestamps: true }
);

partnerApplicationSchema.index({ applicationNumber: 1 }, { unique: true, partialFilterExpression: { applicationNumber: { $type: 'string' } } });
partnerApplicationSchema.index({ 'payment.razorpayOrderId': 1 });
partnerApplicationSchema.index({ 'payment.razorpayOrderHistory': 1 });
partnerApplicationSchema.index({ 'payment.razorpayPaymentId': 1 }, { sparse: true });
partnerApplicationSchema.index({ status: 1, submittedAt: -1 });
partnerApplicationSchema.index({ phone: 1 });

export default mongoose.model('PartnerApplication', partnerApplicationSchema);
