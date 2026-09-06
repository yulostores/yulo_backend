import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['home', 'work', 'other'], default: 'home' },
    // Only meaningful (and only ever set) when label === 'other' — see the
    // add/updateAddress logic in services/user.service.js, which clears this whenever
    // label is changed back to 'home'/'work' so it can't go stale.
    customLabel: { type: String, default: null },
    street: { type: String },
    city: { type: String },
    state: { type: String },
    pincode: { type: String },
    location: {
      type: { type: String, default: 'Point' },
      coordinates: [Number],
    },
    // Who receives the order at THIS address, when that isn't the account holder — a
    // parent's house, an office reception, a gift. Optional: checkout falls back to the
    // account's own name/phone (services/order.service.js's createOrderFromCart), so an
    // ordinary address needs neither. Snapshotted onto
    // Order.deliveryAddress.contactName/contactPhone at placement, which is what the
    // restaurant and the delivery partner actually read — before this, the only contact
    // anywhere near a delivery order was a User.name that nothing ever set.
    contactName: { type: String, default: null },
    contactPhone: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
  },
  {}
);

const notificationCategorySchema = new mongoose.Schema(
  { key: { type: String, required: true }, enabled: { type: Boolean, default: true } },
  { _id: false }
);

// Three separate veg-related fields, kept deliberately distinct rather than collapsed into
// one flag — they answer different questions and are read by different screens:
// vegModeEnabled/vegModeScope filter what menu content is shown app-wide (Home, Search,
// Restaurant, Item); vegFleetPreferenceEnabled is the customer's default answer to the
// per-order "use a veg-only delivery fleet?" checkout choice (Order.vegFleetOptIn is the
// actual per-order value — this is just the pre-filled default for that toggle).
const preferencesSchema = new mongoose.Schema(
  {
    vegModeEnabled: { type: Boolean, default: false },
    vegModeScope: {
      type: String,
      enum: ['all_restaurants', 'pure_veg_only'],
      default: 'all_restaurants',
    },
    vegFleetPreferenceEnabled: { type: Boolean, default: false },
    preferredLanguage: { type: String, default: 'en' },
    notifications: {
      pushEnabled: { type: Boolean, default: false },
      // Function default (not a literal array) so Mongoose doesn't share one array
      // instance's reference across every document that falls back to the default.
      categories: {
        type: [notificationCategorySchema],
        default: () => [{ key: 'orders_and_purchases', enabled: true }],
      },
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    // Optional/sparse rather than required: a customer created via phone+OTP (see
    // controllers/auth.controller.js's verifyCustomerOtp) has neither at creation time —
    // name is completed later via PATCH /api/users/me, same as delivery-partner onboarding
    // happens after the bare phone-only DeliveryPartner record is auto-created on first OTP verify.
    name: { type: String, trim: true, default: '' },
    // No `default: null` on email/phone: with a sparse unique index, a stored `null` still
    // counts as a value and collides across documents. Leaving the field genuinely absent
    // (undefined) when unset is what makes `sparse: true` actually skip those documents.
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: null },
    phone: { type: String, unique: true, sparse: true, trim: true },
    role: { type: String, enum: ['customer', 'restaurant_owner', 'admin'], default: 'customer' },
    savedAddresses: [addressSchema],
    profilePicture: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    phoneVerifiedAt: { type: Date, default: null },
    tosAcceptedAt: { type: Date, default: null },
    // No separate `avatarUrl` field: `profilePicture` above already stores this — see
    // PATCH /api/users/me in controllers/user.controller.js, which accepts an `avatarUrl`
    // request field and writes it to this same column rather than duplicating storage.
    preferences: { type: preferencesSchema, default: () => ({}) },
  },
  { timestamps: true }
);

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

export default mongoose.model('User', userSchema);
