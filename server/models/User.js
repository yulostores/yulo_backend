import mongoose from 'mongoose';

const addressLocationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true },
    // `required` on both halves so a partial point cannot be persisted: a 2dsphere index
    // (present or added later) rejects one, and every reader here treats a half-written
    // point as a real one.
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite),
        message: 'coordinates must be [longitude, latitude]',
      },
    },
  },
  { _id: false }
);

// A delivery address, kept in the parts a rider actually navigates by rather than as one
// free-text line.
//
// The app has always ASKED for a flat number, a floor and a landmark — and then joined them
// into `street` with commas before sending, because those were the only fields that existed
// here. Everything downstream paid for it: the rider got "B-402, Floor 4, Near City Mall"
// with no way to tell which part was the building, the customer could not edit one part
// without retyping the line, and the "edit address" screen could not repopulate the form it
// had just collected. They are separate fields now, the way every delivery app stores them.
//
// `street` survives as the composed one-line form, so older app builds, existing orders and
// every screen that just prints an address keep working unchanged — it is now derived
// (services/address.service.js composes it) rather than the only place the detail lives.
const addressSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ['home', 'work', 'other'], default: 'home' },
    // Only meaningful (and only ever set) when label === 'other' — see the
    // add/updateAddress logic in services/user.service.js, which clears this whenever
    // label is changed back to 'home'/'work' so it can't go stale.
    customLabel: { type: String, default: null },

    // ── The parts the customer types ──────────────────────────────────────────────
    // Flat / house / block number — the single most important line for a rider at the
    // door, and the one a geocoder can never supply.
    houseNumber: { type: String, default: null },
    floor: { type: String, default: null },
    // Building / apartment / society name.
    building: { type: String, default: null },
    landmark: { type: String, default: null },

    // ── The parts a geocoder resolves ─────────────────────────────────────────────
    // Locality / neighbourhood / sector, between the street and the city. HERE returns it
    // as `district`; it is what makes an Indian address findable and was previously thrown
    // away entirely.
    area: { type: String, default: null },
    street: { type: String },
    city: { type: String },
    state: { type: String },
    pincode: { type: String },
    country: { type: String, default: 'India' },
    // The provider's own single-line rendering of the pin, kept verbatim. Useful when the
    // parsed parts disagree with what the customer saw on the map screen.
    formattedAddress: { type: String, default: null },

    // GeoJSON [longitude, latitude].
    //
    // Declared as its OWN schema with `default: undefined`, not as an inline nested path.
    // The difference is the whole bug: a nested path is materialised by Mongoose whenever
    // the parent document is created, so an address whose geocode failed was stored as
    // `{ type: 'Point', coordinates: [] }` — truthy, correctly typed, and completely
    // empty. Every consumer mistook it for a real location: the customer app read it as
    // `{ latitude: undefined }` and stopped loading the home feed altogether, and
    // computeDropKm turned it into NaN on the rider's distance pay. As a sub-schema
    // defaulting to undefined, "no location" is genuinely the absence of the field.
    //
    // services/address.service.js#normalizeLocation is the only thing that writes it.
    location: { type: addressLocationSchema, default: undefined },
    // How the coordinates were obtained, so a support agent (and the repair script) can
    // tell a dragged-pin address from one the geocoder guessed off a typed line.
    locationSource: {
      type: String,
      enum: ['device', 'map_pin', 'geocoded', 'unknown'],
      default: 'unknown',
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
    // 'guest' — an anonymous browsing session minted by POST /api/auth/customer/guest
    // (controllers/auth.controller.js's guestLogin). Same shape as a customer (no
    // phone/email at creation) so it can use the cart/favorites/preferences/address
    // endpoints unchanged; checkout, orders, reviews and support all reject it via
    // middleware/requireCustomerAccount.js. Upgraded in place to 'customer' (or merged
    // into an existing customer account — see services/guestAccount.service.js) the
    // moment the same session completes a real phone+OTP verify.
    role: { type: String, enum: ['customer', 'restaurant_owner', 'admin', 'guest'], default: 'customer' },
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

// No 2dsphere index on savedAddresses.location, deliberately. Nothing queries addresses
// geospatially (every distance calculation already has the point in hand), and building one
// against live data would FAIL rather than help: Mongo refuses to extract geo keys from the
// `{ type: 'Point', coordinates: [] }` documents the old schema default produced, so an
// autoIndex build would error on startup until every such row is repaired. If a geospatial
// address query is ever needed, run scripts/fixAddressLocations.js first, then add it.

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  return obj;
};

export default mongoose.model('User', userSchema);
