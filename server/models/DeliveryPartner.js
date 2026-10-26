import mongoose from 'mongoose';

const deliveryPartnerDocumentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'aadhar_card',
        'driving_license',
        'vehicle_rc',
        'insurance_document',
        'profile_photo',
      ],
    },
    url: { type: String },
    // Per-document review state, set by admin (see controllers/admin/deliveryPartner.controller.js's
    // verifyDocument) — mirrors Restaurant's restaurantDocumentSchema.status. Defaults to 'pending'
    // on every new/replaced upload (Step 3's onboarding.controller.js relies on this default so a
    // resubmitted document automatically needs fresh review rather than inheriting the old verdict).
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const completedTrainingModuleSchema = new mongoose.Schema(
  {
    moduleId: { type: String, required: true },
    quizScore: { type: Number, required: true },
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const deliveryPartnerSchema = new mongoose.Schema(
  {
    // Not required at the schema level: a partner created via OTP self-registration
    // (see controllers/partner/auth.controller.js) starts with only `phone` set — fullName/email
    // are submitted later during onboarding. Admin-created partners still require both; that's
    // enforced explicitly in controllers/admin/deliveryPartner.controller.js's `create`, since it
    // no longer gets that check for free from this schema.
    fullName: { type: String, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    // Login identifier for the partner-facing app (OTP is sent to this number) — must be unique.
    phone: { type: String, required: true, unique: true },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ['male', 'female', 'other'] },
    emergencyPhone: { type: String },
    aadharNumber: { type: String },
    panNumber: { type: String },
    vehicle: {
      model: { type: String },
      number: { type: String },
      type: { type: String, enum: ['2_wheeler', 'ev_2_wheeler', 'non_rto_2_wheeler'] },
      rcNumber: { type: String },
      insuranceProvider: { type: String },
      insuranceNumber: { type: String },
      insuranceValidTill: { type: Date },
    },
    documents: [deliveryPartnerDocumentSchema],
    bankDetails: {
      bankName: { type: String },
      accountHolderName: { type: String },
      accountNumber: { type: String },
      accountType: { type: String, enum: ['savings', 'current'] },
      ifscCode: { type: String },
      branchName: { type: String },
      upiId: { type: String },
    },
    // DUTY/ELIGIBILITY status — whether this partner is currently on-duty and eligible for
    // auto-assignment (see services/deliveryAssignment.service.js). This is NOT the KYC/document
    // verification state; that's tracked separately by `verificationStatus` below. A partner
    // must not be allowed to set this to 'active' unless verificationStatus === 'approved' — that
    // guard belongs in the duty-toggle endpoint (POST /api/partner/duty/toggle, added in a later
    // step), not here, since going on/off duty is a partner action while this schema only stores
    // the result.
    status: { type: String, enum: ['active', 'busy', 'inactive', 'suspended'], default: 'active' },
    // KYC/onboarding verification state, independent of duty status above.
    verificationStatus: {
      type: String,
      enum: ['pending_documents', 'under_review', 'approved', 'rejected', 'resubmission_required'],
      default: 'pending_documents',
    },
    // Admin's reason on rejection or resubmission request.
    verificationNotes: { type: String },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fleetType: { type: String, enum: ['veg', 'standard'], default: 'standard' },
    // Single flat in-progress state, not per-module records — OnboardingContext.jsx's single
    // `training` object (not a map/array) confirms a partner only ever has ONE current module in
    // flight, never concurrent tracks. The ordered module list itself (ids/labels/durations)
    // lives in services/training.service.js, not here — currentModuleId is null until training
    // starts, at which point the service lazily treats null as "the first module" (same
    // compute-on-read convention as payout.service.js's ensurePayoutForPeriod).
    training: {
      currentModuleId: { type: String, default: null },
      watchedSeconds: { type: Number, default: 0 },
      completedModules: [completedTrainingModuleSchema],
      lastQuizScore: { type: Number, default: null },
      certificateStatus: { type: String, enum: ['pending', 'issued'], default: 'pending' },
    },
    // Field list matches Delivery-Partner/src/screens/profile/Notifications.jsx's toggle rows
    // exactly (orders/payments/promotions/appUpdates/soundVibration) — all default true, same as
    // that screen's local useState(true) per row.
    notificationPreferences: {
      orders: { type: Boolean, default: true },
      payments: { type: Boolean, default: true },
      promotions: { type: Boolean, default: true },
      appUpdates: { type: Boolean, default: true },
      soundVibration: { type: Boolean, default: true },
    },
    // The Expo push token of the phone the rider is signed in on (PUT
    // /api/partner/notifications/push-token). How an order offer reaches a rider whose app is in
    // the background or whose screen is locked — Android closes the socket then. Null until the
    // app registers one, and cleared on sign-out or when Expo reports the device unregistered.
    pushToken: { type: String, default: null },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    totalDeliveries: { type: Number, default: 0 },
    joinedOn: { type: Date, default: Date.now },
    // Deliberately no schema-level default on `type` (unlike Restaurant.location, which always
    // has real coordinates from creation) — a fresh partner has never sent a location ping, and
    // defaulting `type` to 'Point' while `coordinates` stays unset would persist a partial,
    // invalid GeoJSON value the moment any other field on this document is saved, which a
    // 2dsphere index rejects. Left fully unset until POST /api/partner/location sets both
    // fields together, atomically (see controllers/partner/location.controller.js).
    currentLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number] },
    },
    // Separate from currentLocation itself so staleness can be checked without re-deriving it
    // from an update timestamp on the whole document (other fields change far more often than
    // location does) — see services/geo.service.js's isLocationFresh.
    currentLocationUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

deliveryPartnerSchema.index({ status: 1 });
// Registering a phone takes its token off any other rider (controllers/partner/profile.controller.js).
deliveryPartnerSchema.index({ pushToken: 1 }, { partialFilterExpression: { pushToken: { $type: 'string' } } });
deliveryPartnerSchema.index({ verificationStatus: 1 });
deliveryPartnerSchema.index({ currentLocation: '2dsphere' });

export default mongoose.model('DeliveryPartner', deliveryPartnerSchema);
