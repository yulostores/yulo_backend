import mongoose from 'mongoose';
import { followUpSchemaFields } from '../services/applicationFollowUp.service.js';
import { APPLICATION_STATUSES, EDUCATION_LEVELS, GENDERS } from '../config/careers.config.js';

// One application from the public careers portal (yulo_careers). Created unpaid
// (`pending_payment`) together with a Razorpay order for the form fee; it becomes a real
// application (`new`) once that payment is verified — by the applicant's verify call or the
// Razorpay webhook, whichever lands first (services/jobApplication.service.js).
//
// There is no applicant account: the browser that created the application holds a random
// access token (only its SHA-256 is stored here) and must present it to pay for it.

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    status: { type: String, default: null }, // the status set together with this note, if any
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const jobApplicationSchema = new mongoose.Schema(
  {
    applicationNumber: { type: String, default: null }, // YJ-000123, given once paid
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true }, // 10 digits
    alternatePhone: { type: String, default: null },
    dateOfBirth: { type: Date, required: true }, // midnight UTC of the calendar date
    gender: { type: String, enum: GENDERS, required: true },
    city: { type: String, required: true, trim: true },

    department: { type: String, required: true }, // config/careers.config.js JOB_DEPARTMENTS key
    role: { type: String, required: true }, // the first role chosen — kept for older screens/filters
    // Every role chosen (1 to MAX_ROLES_PER_APPLICATION, same department). Older applications
    // have only `role`; read them as [role].
    roles: { type: [String], default: undefined },

    // Monthly, rupees.
    expectedSalaryMin: { type: Number, required: true },
    expectedSalaryMax: { type: Number, required: true },
    currentSalary: { type: Number, default: null },

    availableFrom: { type: Date, default: null },
    education: { type: String, enum: [...EDUCATION_LEVELS.map((e) => e.key), null], default: null },
    experienceYears: { type: Number, default: null },
    experience: { type: String, default: null },

    resume: {
      type: new mongoose.Schema(
        {
          url: String,
          publicId: String,
          resourceType: { type: String, default: 'raw' },
          name: String,
          mimeType: String,
          size: Number,
          uploadedAt: Date,
        },
        { _id: true }
      ),
      default: null,
    },

    status: { type: String, enum: APPLICATION_STATUSES, default: 'pending_payment' },
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

jobApplicationSchema.index({ applicationNumber: 1 }, { unique: true, partialFilterExpression: { applicationNumber: { $type: 'string' } } });
jobApplicationSchema.index({ 'payment.razorpayOrderId': 1 });
jobApplicationSchema.index({ 'payment.razorpayOrderHistory': 1 });
jobApplicationSchema.index({ 'payment.razorpayPaymentId': 1 }, { sparse: true });
jobApplicationSchema.index({ status: 1, submittedAt: -1 });
jobApplicationSchema.index({ phone: 1, role: 1 });
jobApplicationSchema.index({ phone: 1, roles: 1 });

export default mongoose.model('JobApplication', jobApplicationSchema);
