// The store-settings form's field contract, in one place.
//
// Which fields exist, what they're labelled, which of them an owner *must* fill in before
// a save is accepted, and the shape each value has to take — all of it lives here and
// nowhere else. Two consumers read it:
//
//   * controllers/owner/settings.controller.js enforces it on PATCH /owner/:rId/settings,
//     so the rule holds for anyone holding the owner's token, not just the form.
//   * GET /api/owner/settings-requirements serves it to the restaurant portal, which
//     renders the labels, the required markers, the dropdown options and the input limits
//     from it and re-runs the same checks client-side for instant feedback.
//
// That second consumer is why the rules are declarative data rather than a zod schema: a
// schema can only answer yes/no on the server, while this can also *describe* itself over
// the wire, so the portal never has to keep its own copy of a label, a pattern or a list
// of options in sync with this file.

import { ALLOWED_IMAGE_MIME_TYPES } from '../middleware/upload.js';

// Indian company classifications — from company law, not from our data, so there is no
// collection to derive them from (unlike cuisines, see controllers/cuisine.controller.js).
export const LEGAL_ENTITY_TYPES = [
  'Sole proprietorship',
  'Partnership',
  'Private Limited',
  'Public Limited',
  'NGO',
  'AOP/BOI',
];

// The `day` enum on models/Restaurant.js's operatingHours, in the order the week reads.
export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const DEFAULT_OPEN_TIME = 900;   // 09:00, as the HHMM integer the model stores
export const DEFAULT_CLOSE_TIME = 2200; // 22:00

// A single ceiling across both brand images — multer has no per-field limit, so
// routes/owner/settings.routes.js passes this to uploadFields and the portal checks a pick
// against it before spending an upload round trip on a file the server will refuse.
export const BRAND_IMAGE_FIELDS = ['logo', 'banner'];
export const BRAND_IMAGE_MAX_MB = 5;

export const EARLIEST_ESTABLISHED_YEAR = 1800; // Restaurant.establishedYear has `min: 1800`

// Patterns are strings, not RegExp literals, because they travel to the browser as JSON
// and are compiled there with `new RegExp` — the source has to stay portable between the
// two. The phone rule is the platform-wide one (routes/auth.routes.js).
const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[A-Za-z]{2,}$';
const PHONE_PATTERN = '^[0-9]{10}$';
const PINCODE_PATTERN = '^[1-9][0-9]{5}$';
const PAN_PATTERN = '^[A-Z]{5}[0-9]{4}[A-Z]$';

// Every field the store-settings screen edits, addressed by its path in the PATCH payload
// (which is also its path on the Restaurant document). `section` is the card it sits in;
// `onCreate` marks the subset POST /owner/restaurants accepts, so the "Add Your
// Restaurant" step can be built from this list too instead of repeating it.
//
// `wide` / `createWide` say the field takes the full width of its two-column card, in the
// settings form and in the create step respectively — the two disagree (the city sits
// beside the state/PIN pair in one and above it in the other), which is why they are two
// flags and not one.
export const STORE_SETTINGS_FIELDS = [
  {
    path: 'name',
    createWide: true,
    label: 'Restaurant Name',
    section: 'profile',
    type: 'text',
    required: true,
    onCreate: true,
    minLength: 2,
    maxLength: 120,
    placeholder: 'Your restaurant name',
  },
  {
    path: 'cuisineTypes',
    label: 'Cuisine Types',
    section: 'profile',
    type: 'tags',
    required: false,
  },
  {
    path: 'email',
    label: 'Email Address',
    section: 'profile',
    type: 'email',
    required: true,
    maxLength: 160,
    pattern: EMAIL_PATTERN,
    patternMessage: 'Enter a valid email address, e.g. hello@restaurant.com',
    placeholder: 'hello@restaurant.com',
  },
  {
    path: 'phone',
    label: 'Phone Number',
    section: 'profile',
    type: 'tel',
    required: true,
    digitsOnly: true,
    maxLength: 10,
    pattern: PHONE_PATTERN,
    patternMessage: 'Enter a valid 10-digit phone number',
    placeholder: '9876543210',
  },
  {
    path: 'website',
    label: 'Website',
    section: 'profile',
    type: 'url',
    required: false,
    maxLength: 200,
    placeholder: 'https://example.com',
  },
  {
    path: 'establishedYear',
    label: 'Established Year',
    section: 'profile',
    type: 'number',
    required: false,
    digitsOnly: true,
    maxLength: 4,
    min: EARLIEST_ESTABLISHED_YEAR,
    // `max` is filled in per request by buildStoreSettingsRequirements — "this year" is not
    // a constant, and a hardcoded one starts rejecting valid input next January.
    integer: true,
    placeholder: '1998',
  },
  {
    path: 'description',
    wide: true,
    label: 'Description',
    section: 'profile',
    type: 'text',
    required: false,
    maxLength: 500,
    placeholder: 'What your restaurant is known for',
  },
  {
    path: 'address.street',
    wide: true,
    createWide: true,
    label: 'Street',
    section: 'profile',
    type: 'text',
    required: true,
    onCreate: true,
    minLength: 3,
    maxLength: 200,
    placeholder: '12 Main Road',
  },
  {
    path: 'address.city',
    createWide: true,
    label: 'City',
    section: 'profile',
    type: 'text',
    required: true,
    onCreate: true,
    minLength: 2,
    maxLength: 80,
    placeholder: 'Delhi',
  },
  {
    path: 'address.state',
    label: 'State',
    section: 'profile',
    type: 'text',
    required: true,
    onCreate: true,
    minLength: 2,
    maxLength: 80,
    placeholder: 'Delhi',
  },
  {
    path: 'address.pincode',
    label: 'PIN Code',
    section: 'profile',
    type: 'text',
    required: true,
    onCreate: true,
    digitsOnly: true,
    maxLength: 6,
    pattern: PINCODE_PATTERN,
    patternMessage: 'Enter a valid 6-digit PIN code',
    placeholder: '110001',
  },

  // ── Business details — all three required. They name the legal entity the store trades
  // as, which is what admin reviews the application against.
  {
    path: 'settings.legalEntityType',
    label: 'Legal Entity Type',
    section: 'business',
    type: 'select',
    required: true,
    options: LEGAL_ENTITY_TYPES,
    placeholder: 'Select type',
  },
  {
    path: 'settings.ownerName',
    label: 'Owner Name',
    section: 'business',
    type: 'text',
    required: true,
    minLength: 2,
    maxLength: 120,
    placeholder: 'Full name',
  },
  {
    path: 'settings.panNumber',
    wide: true,
    label: 'Tax Identifier (PAN)',
    section: 'business',
    type: 'text',
    required: true,
    transform: 'uppercase',
    maxLength: 10,
    pattern: PAN_PATTERN,
    patternMessage: 'Enter a valid PAN, e.g. ABCDE1234F',
    placeholder: 'ABCDE1234F',
  },

  // ── Licenses & tax — optional here; the scans behind them are reviewed separately
  // (POST /owner/:rId/documents).
  {
    path: 'settings.gstNumber',
    wide: true,
    label: 'GST Number',
    section: 'licenses',
    type: 'text',
    required: false,
    transform: 'uppercase',
    maxLength: 15,
    placeholder: '27AACR1234F1Z1',
  },
  {
    path: 'settings.healthPermitId',
    label: 'FSSAI License No.',
    section: 'licenses',
    type: 'text',
    required: false,
    maxLength: 40,
    placeholder: 'H-992-B',
  },
  {
    path: 'settings.licenseExpiry',
    label: 'FSSAI Expiry Date',
    section: 'licenses',
    type: 'date',
    required: false,
  },
  {
    path: 'settings.registrationNo',
    label: 'Trade License No.',
    section: 'licenses',
    type: 'text',
    required: false,
    maxLength: 40,
    placeholder: 'REG-9912002',
  },
  {
    path: 'settings.tradeLicenseExpiry',
    label: 'Trade License Expiry',
    section: 'licenses',
    type: 'date',
    required: false,
  },

  // ── Delivery logistics. The zod schema on PATCH /settings/delivery is built from these
  // same bounds — see routes/owner/settings.routes.js.
  {
    path: 'delivery.radiusKm',
    label: 'Radius (km)',
    section: 'delivery',
    type: 'number',
    required: false,
    min: 0,
    max: 100,
    step: 0.5,
  },
  {
    path: 'delivery.baseCharge',
    label: 'Base Charge (₹)',
    section: 'delivery',
    type: 'number',
    required: false,
    min: 0,
  },
  {
    path: 'delivery.freeThreshold',
    label: 'Free Delivery Above (₹)',
    section: 'delivery',
    type: 'number',
    required: false,
    min: 0,
    placeholder: 'Leave blank for none',
  },
  {
    path: 'delivery.estimatedMinutes',
    label: 'Estimated Time (min)',
    section: 'delivery',
    type: 'number',
    required: false,
    min: 0,
    max: 24 * 60,
    integer: true,
  },

  // ── Brand assets. Not form values — the limits are what the portal validates a pick
  // against, and they mirror the multer config these same constants configure.
  {
    path: 'logo',
    label: 'Store Logo',
    section: 'brand',
    type: 'image',
    required: false,
    hint: `Upload image (max ${BRAND_IMAGE_MAX_MB} MB)`,
  },
  {
    path: 'bannerImage',
    label: 'Banner Image',
    section: 'brand',
    type: 'image',
    required: false,
    hint: '1920×1080 recommended',
  },
];

export const DELIVERY_FIELDS = STORE_SETTINGS_FIELDS.filter((f) => f.section === 'delivery');

const fieldsByPath = new Map(STORE_SETTINGS_FIELDS.map((f) => [f.path, f]));
export const getStoreSettingsField = (path) => fieldsByPath.get(path);

// Reads `address.city` out of { address: { city } }. Mongoose subdocuments answer to
// property access the same way plain objects do, so this works on a hydrated document.
export const getByPath = (obj, path) =>
  path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

// One rule engine, applied to one field. The restaurant portal carries a line-for-line twin
// of this (src/lib/fieldRules.js) so the message an owner sees while typing is the same one
// the server would answer with.
export const validateField = (field, rawValue) => {
  const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  const isEmpty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (isEmpty) {
    return field.required ? field.requiredMessage ?? `${field.label} is required` : null;
  }

  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${field.label} must be a number`;
    if (field.integer && !Number.isInteger(n)) return `${field.label} must be a whole number`;
    if (field.min !== undefined && n < field.min) return `${field.label} must be ${field.min} or more`;
    if (field.max !== undefined && n > field.max) return `${field.label} must be ${field.max} or less`;
    return null;
  }

  if (typeof value !== 'string') return null;

  if (field.minLength && value.length < field.minLength) {
    return `${field.label} must be at least ${field.minLength} characters`;
  }
  if (field.maxLength && value.length > field.maxLength) {
    return `${field.label} must be at most ${field.maxLength} characters`;
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    return field.patternMessage ?? `Enter a valid ${field.label.toLowerCase()}`;
  }
  if (field.options && !field.options.includes(value)) {
    return `Choose a ${field.label.toLowerCase()} from the list`;
  }
  return null;
};

// Server-side gate for PATCH /owner/:rId/settings. Only the required fields are checked
// here, and deliberately so: an owner whose *optional* GST number was captured in some
// older format must still be able to save a phone-number correction, so a legacy value
// they aren't touching can't be what blocks the form. The portal runs the full rule set
// over what is on screen, and the required fields — the ones this gate exists for — are
// enforced in both places.
//
// `doc` is the restaurant as it *would* be after the patch, so leaving a required field out
// of the request doesn't slip past the check by simply not being mentioned.
export const validateRequiredStoreSettings = (doc) => {
  const fieldErrors = {};
  for (const field of STORE_SETTINGS_FIELDS) {
    if (!field.required) continue;
    const message = validateField(field, getByPath(doc, field.path));
    if (message) fieldErrors[field.path] = message;
  }
  return fieldErrors;
};

// The same gate for POST /owner/restaurants, which accepts only the `onCreate` subset —
// checking the rest there would reject an application for details the endpoint has no way
// to receive.
export const validateCreateRestaurant = (doc) => {
  const fieldErrors = {};
  for (const field of STORE_SETTINGS_FIELDS) {
    if (!field.required || !field.onCreate) continue;
    const message = validateField(field, getByPath(doc, field.path));
    if (message) fieldErrors[field.path] = message;
  }
  return fieldErrors;
};

// The requirements document the portal fetches. Assembled per request because
// `establishedYear`'s upper bound is "this year".
export const buildStoreSettingsRequirements = () => ({
  fields: STORE_SETTINGS_FIELDS.map((field) =>
    field.path === 'establishedYear' ? { ...field, max: new Date().getFullYear() } : field
  ),
  hours: {
    days: DAYS,
    defaultOpenTime: DEFAULT_OPEN_TIME,
    defaultCloseTime: DEFAULT_CLOSE_TIME,
    incompleteMessage: 'Set an opening and closing time for every open day',
  },
  brandImage: {
    fields: BRAND_IMAGE_FIELDS,
    maxSizeMB: BRAND_IMAGE_MAX_MB,
    maxBytes: BRAND_IMAGE_MAX_MB * 1024 * 1024,
    allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES,
    accept: ALLOWED_IMAGE_MIME_TYPES.join(','),
  },
});
