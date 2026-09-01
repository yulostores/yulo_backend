import mongoose from 'mongoose';

const operatingHoursSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    },
    isOpen: { type: Boolean, default: true },
    openTime: { type: Number },
    closeTime: { type: Number },
  },
  { _id: false }
);

const restaurantDocumentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'fssai_license',
        'business_registration',
        'gst_certificate',
        'pan_card',
        'address_proof',
        'bank_statement',
      ],
    },
    url: { type: String },
    status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    uploadedAt: { type: Date, default: Date.now },
  }
);

const adminNoteSchema = new mongoose.Schema(
  {
    note: { type: String, required: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const restaurantSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    category: { type: String },
    cuisineTypes: [String],
    coverImage: { type: String },
    logo: { type: String },
    bannerImage: { type: String },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
    // Public contact details for the storefront — distinct from the owner's own
    // User.email / User.phone, which are login credentials and must not be shown to
    // customers. A restaurant's published address book lives here so it can be edited
    // (and displayed) without touching the owner account.
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },
    establishedYear: { type: Number, min: 1800 },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true },
    },
    operatingHours: [operatingHoursSchema],
    delivery: {
      radiusKm: { type: Number, default: 5 },
      baseCharge: { type: Number, default: 0 },
      freeThreshold: { type: Number },
      estimatedMinutes: { type: Number },
    },
    settings: {
      legalEntityType:      { type: String },
      ownerName:            { type: String },
      alternatePhone:       { type: String },
      panNumber:            { type: String },
      gstNumber:            { type: String },
      gstPercent:           { type: Number, default: 5 },
      serviceChargePercent: { type: Number, default: 10 },
      healthPermitId:       { type: String },
      licenseExpiry:        { type: Date },
      registrationNo:       { type: String },
      tradeLicenseExpiry:   { type: Date },
    },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    // Menu-composition flag ("every dish here is vegetarian") — distinct from
    // vegFleetAvailable below, which is about delivery logistics, not what's on the menu.
    isPureVeg: { type: Boolean, default: false },
    // Whether ANY delivery partner covering this restaurant's area carries a dedicated
    // veg-only fleet bag (DeliveryPartner.fleetType === 'veg'). Manually toggled by the
    // owner/admin for now — computing this live from actual partner coverage is
    // prompt 11's job, once checkout needs a real-time (not just advertised) answer.
    vegFleetAvailable: { type: Boolean, default: false },
    // Free-form tags for restaurant cards (e.g. "great_offers") — unused by any endpoint
    // yet; populated once search/home (prompts 7-8) have something to put here.
    badges: [String],
    avgRating: { type: Number, default: 0, min: 0, max: 5 },
    totalRatings: { type: Number, default: 0 },
    approvalStatus: {
      type: String,
      enum: ['pending', 'active', 'suspended', 'rejected', 'expired'],
      default: 'pending',
    },
    plan: { type: String, enum: ['trial', 'basic', 'standard', 'premium'], default: 'trial' },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },
    documents: [restaurantDocumentSchema],
    adminNotes: [adminNoteSchema],
  },
  { timestamps: true }
);

restaurantSchema.index({ location: '2dsphere' });
restaurantSchema.index({ name: 'text', description: 'text' });
restaurantSchema.index({ ownerId: 1 });
restaurantSchema.index({ approvalStatus: 1 });

export default mongoose.model('Restaurant', restaurantSchema);
