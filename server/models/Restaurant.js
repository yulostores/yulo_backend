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
        // Proof for a requested change of a verified bank account — becomes the bank_statement
        // when an admin verifies the change (services/payoutAccount.service.js).
        'bank_statement_change',
      ],
    },
    url: { type: String },
    // Original filename and content type, captured at upload. The admin portal renders the
    // document inline (image vs. PDF viewer) and lists it by the name the owner recognises —
    // both of which had to be guessed from the Cloudinary URL before these were stored, which
    // gets the extension wrong for anything uploaded as `resource_type: 'auto'`.
    name: { type: String },
    mimeType: { type: String },
    // Cloudinary identity, kept alongside the URL. Deleting an asset needs the resource
    // type as well as the public id (the URL alone can't be trusted to yield either after
    // a folder rename), and the authenticated file endpoint needs both to fall back to a
    // signed download when plain delivery is refused — which is exactly what Cloudinary
    // does for PDFs unless the account opts into public PDF delivery.
    publicId: { type: String },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'image' },
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
      // NO schema default, deliberately. A default here is indistinguishable from a value
      // the owner chose, and that is exactly what went wrong: every restaurant created
      // through a form that doesn't ask about delivery (owner sign-up, the admin console's
      // Add Store) was silently written with `radiusKm: 5` and then hidden from every
      // customer more than 5 km away — a restriction nobody set and nobody could see.
      //
      // Left unset, `effectiveDeliveryRadiusKm` (config/delivery.config.js) treats it as
      // "the owner has not restricted their reach" and applies the full discovery radius.
      // The default lives there, in one place, where it can be reasoned about — rather than
      // being baked into the document at creation where it outlives any change to it.
      radiusKm: { type: Number },
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
    // Whether the restaurant is registered for GST. Drives whether food GST is charged on its
    // orders at all (pricing, B3) and makes settings.gstNumber mandatory on the store-settings
    // form (config/storeSettings.config.js). Existing restaurants were backfilled from whether
    // a GST number was on file — scripts/backfillGstRegistered.js.
    //
    // The default applies to NEW restaurants only. A plain `default: false` would also be
    // filled in on every legacy restaurant Mongoose loads, and written back by the next save
    // of that document (an admin suspend, a document upload…) — permanently recording
    // "not registered" for a restaurant the backfill would have marked registered, and
    // silently dropping its food GST. Left unset instead, a legacy restaurant stays visibly
    // "not backfilled yet" until the script decides.
    gstRegistered: { type: Boolean, default: function defaultGstRegistered() { return this.isNew ? false : undefined; } },
    // Who last decided gstRegistered: 'created' (the default on a new restaurant), 'owner'
    // (store settings), 'admin' (store profile) or 'backfill'. A legacy restaurant has none —
    // which is how the backfill tells a value nobody chose (safe to decide) from a real one.
    gstRegisteredSource: {
      type: String,
      enum: ['created', 'owner', 'admin', 'backfill'],
      default: function defaultGstRegisteredSource() { return this.isNew ? 'created' : undefined; },
    },
    gstRegisteredSetAt: { type: Date },
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
    // Live customer activity, turned on for this restaurant by a super admin (store page →
    // PATCH /api/admin/stores/:id/live-activity; services/liveActivityAccess.service.js). It
    // only matters while LIVE_ACTIVITY_ENABLED is on. No default and `select: false`: unset means
    // off, and no existing restaurant response gains a field — only the admin store view and the
    // access service ask for it.
    liveActivityEnabled: { type: Boolean, select: false },
    submittedAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },
    documents: [restaurantDocumentSchema],
    adminNotes: [adminNoteSchema],
    // Where the weekly settlement is paid. Owner-entered, admin-verified before any payout goes
    // to it (services/payoutAccount.service.js). The account number is stored ONLY encrypted
    // (AES-256-GCM, utils/fieldEncryption.js) and that field is select:false — no query returns
    // it unless the code asks, so the many places that send a restaurant document to a client
    // can never leak it. Clients see accountNumberLast4; an admin can reveal the full number,
    // and every reveal is audit-logged.
    payoutAccount: {
      accountHolderName: { type: String, trim: true, default: null },
      accountNumberEncrypted: { type: String, default: null, select: false },
      accountNumberLast4: { type: String, default: null },
      ifsc: { type: String, uppercase: true, trim: true, default: null },
      bankName: { type: String, trim: true, default: null },
      branch: { type: String, trim: true, default: null },
      accountType: { type: String, enum: ['savings', 'current', null], default: null },
      status: {
        type: String,
        enum: ['not_added', 'pending_verification', 'verified', 'rejected'],
        default: 'not_added',
      },
      rejectionReason: { type: String, default: null },
      submittedAt: { type: Date, default: null },
      verifiedAt: { type: Date, default: null },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      // The payout provider's beneficiary records (RazorpayX contact + fund account, B9) —
      // cleared whenever the account changes, since they point at the old one.
      providerContactId: { type: String, default: null },
      providerFundAccountId: { type: String, default: null },
      // A change the owner asked for to a VERIFIED account (B12). The verified account above
      // stays in force — and scheduled / failed payouts keep going to it — until an admin
      // verifies this one, which then replaces it. A plain nested object, not a sub-schema:
      // the select:false number inside must stay a schema path of its own so the public
      // projection (utils/publicRestaurant.js) can exclude its siblings without colliding.
      //   status  in_review            waiting for an admin
      //           awaiting_restaurant  the admin asked the owner for information (infoRequest)
      //           rejected             refused (rejectionReason); the owner may submit again
      pendingChange: {
        accountHolderName: { type: String, trim: true, default: null },
        accountNumberEncrypted: { type: String, default: null, select: false },
        accountNumberLast4: { type: String, default: null },
        ifsc: { type: String, uppercase: true, trim: true, default: null },
        bankName: { type: String, trim: true, default: null },
        branch: { type: String, trim: true, default: null },
        accountType: { type: String, enum: ['savings', 'current', null], default: null },
        proofDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null },
        status: { type: String, enum: ['in_review', 'awaiting_restaurant', 'rejected', null], default: null },
        requestedAt: { type: Date, default: null },
        infoRequest: {
          message: { type: String, default: null },
          at: { type: Date, default: null },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        },
        rejectionReason: { type: String, default: null },
      },
    },
  },
  { timestamps: true }
);

restaurantSchema.index({ location: '2dsphere' });
restaurantSchema.index({ name: 'text', description: 'text' });
restaurantSchema.index({ ownerId: 1 });
restaurantSchema.index({ approvalStatus: 1 });
// The few restaurants with live customer activity on (loaded at boot and re-read on a timer).
restaurantSchema.index({ liveActivityEnabled: 1 }, { partialFilterExpression: { liveActivityEnabled: true } });
// Admin 'Bank requests' queue (payoutAccount.service.js listBankRequests).
restaurantSchema.index(
  { 'payoutAccount.pendingChange.status': 1, 'payoutAccount.pendingChange.requestedAt': 1 },
  { partialFilterExpression: { 'payoutAccount.pendingChange.status': { $type: 'string' } } }
);

export default mongoose.model('Restaurant', restaurantSchema);
