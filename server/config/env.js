import 'dotenv/config';
import { z } from 'zod';

// "true"/"false" from the environment as a real boolean. z.coerce.boolean() is not usable
// here: it turns the string "false" into `true`.
const envFlag = (defaultValue) =>
  z.enum(['true', 'false']).default(defaultValue ? 'true' : 'false').transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  MONGODB_URI: z.string().url(),
  REDIS_URL: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_STAFF_SECRET: z.string().min(32),
  JWT_PARTNER_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_REFRESH_EXPIRES: z.string().default('7d'),
  JWT_PARTNER_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_PARTNER_REFRESH_EXPIRES: z.string().default('30d'),
  // Server-side error monitoring. Unset → Sentry is a complete no-op (see instrument.js).
  // instrument.js reads these from process.env directly because it has to run before this
  // schema is parsed; they are declared here so the shape is documented and validated.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  CLOUDINARY_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // HERE Location Services. Powers road routing + traffic ETAs on the tracking screen
  // (services/routing.service.js) and the /api/geo/* address endpoints (services/places.service.js).
  // Unset is safe: routing falls back to straight-line estimates and geocoding to Nominatim.
  HERE_API_KEY: z.string().optional(),
  // Legacy. The platform standardised on HERE; nothing reads this except the dormant Google
  // branch in services/geocode.service.js, kept only so an existing deployment that still has
  // this set does not silently change geocoding provider on deploy.
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Dev/local only: lets the /payment/simulate endpoints mark an order or bill paid with no
  // gateway involved. Ignored outright when NODE_ENV=production — see config/payments.config.js.
  ALLOW_PAYMENT_SIMULATION: envFlag(false),
  // SEED DEFAULT ONLY — cash on delivery now lives in Finance Settings (codEnabled), edited
  // from the super admin portal. This value is read once, when the very first settings version
  // is created on an empty database (services/financeSettings.service.js). Unset → false.
  COD_ENABLED: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  // AES-256-GCM key for field-level encryption of sensitive stored data (restaurant bank
  // account numbers — utils/fieldEncryption.js). 32 random bytes, base64. Required in production
  // (checked below). Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  DATA_ENCRYPTION_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v), // an empty line copied from .env.example means "unset"
    z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded')
      .optional()
  ),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  // Per-IP requests/minute across /api. A dashboard load costs ~25.
  RATE_LIMIT_MAX: z.coerce.number().default(600),
  // 'none' (which forces Secure) is required when the frontend is served from a
  // different site than this API. 'lax' covers localhost ports and a shared
  // registrable domain. See utils/refreshCookie.js.
  //
  // Deliberately no static default: the safe value differs per environment, and the
  // wrong one fails silently (the browser keeps the cookie but never sends it, so every
  // page reload signs the user out). Resolved from NODE_ENV below.
  REFRESH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
  CUSTOMER_APP_URL: z.string().url().optional(),
  // Where table QR codes point — the yulo_menu guest-ordering app. Falls back to
  // CUSTOMER_APP_URL below so nothing breaks before this is set in each environment.
  MENU_APP_URL: z.string().url().optional(),
  // SEED DEFAULTS ONLY (rupees / percent, as before). Rates now live in Finance Settings and
  // are edited from the super admin portal; these are read once, when the first settings
  // version is created on an empty database, and ignored after that. Unset → the business
  // defaults in services/financeSettings.service.js. PLATFORM_COMMISSION_PERCENT is gone:
  // the flat commission was replaced by the settlement charge (settlementChargePercent).
  DELIVERY_PARTNER_PER_DELIVERY_RATE: z.coerce.number().min(0).optional(), // → riderBasePay
  DELIVERY_PARTNER_PER_KM_RATE: z.coerce.number().min(0).optional(), // → riderPerKmRate
  CART_PLATFORM_FEE: z.coerce.number().min(0).optional(), // → customerPlatformFee
  CART_TAX_PERCENT: z.coerce.number().min(0).max(100).optional(), // → foodGstPercent
  DELIVERY_PARTNER_MAX_CONCURRENT_ORDERS: z.coerce.number().default(1),
  DELIVERY_OFFER_WINDOW_SECONDS: z.coerce.number().default(20),
  MESSAGECENTRAL_CUSTOMER_ID: z.string().optional(),
  MESSAGECENTRAL_KEY: z.string().optional(),
  MESSAGECENTRAL_EMAIL: z.string().email().optional(),
  MESSAGECENTRAL_BASE_URL: z.string().url().default('https://cpaas.messagecentral.com'),
  // 'mock'          — generate the code locally and log/echo it (dev default).
  // 'messagecentral'— generate and deliver via MessageCentral (real SMS, costs credits).
  // 'bypass'        — TEMPORARY. No provider call at all: any 6-digit code verifies a
  //                   number that has requested one. In place while the MessageCentral
  //                   balance is exhausted; revert by setting 'messagecentral' again.
  //                   Nothing else has to change — see services/otp.service.js.
  SMS_PROVIDER: z.enum(['mock', 'messagecentral', 'bypass']).default('mock'),
  // Per-phone OTP send budget inside a 10-minute window. Raise it while testing the
  // login flow end to end; the default is the production-safe value.
  OTP_MAX_REQUESTS_PER_WINDOW: z.coerce.number().int().min(1).default(3),
  // How long a customer order may wait for the restaurant to accept it before it is
  // cancelled automatically ("the restaurant didn't respond"). Keeps a customer from waiting
  // forever on an owner portal nobody is watching. See services/orderApproval.service.js.
  ORDER_APPROVAL_TIMEOUT_MINUTES: z.coerce.number().min(1).default(15),
  // Live customer activity + personalized offers (yulo_backend/LIVE_ACTIVITY_IMPLEMENTATION_PROMPTS.md).
  // Off by default: with it off, every existing endpoint, response and socket event is unchanged.
  LIVE_ACTIVITY_ENABLED: envFlag(false),
  // Pilot allow-list — comma-separated restaurant ids. Empty means every restaurant (when
  // enabled). Ids that aren't valid ObjectIds are ignored with a startup warning
  // (config/liveActivity.config.js).
  LIVE_ACTIVITY_RESTAURANT_IDS: z.string().default(''),
  // Local-only: much shorter session timings so idle/abandoned can be walked through by hand.
  // Refused in production (below).
  LIVE_ACTIVITY_TEST_TIMINGS: envFlag(false),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment variables:');
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// A signing secret that still carries its committed dev placeholder is worse than a missing
// one: the .min(32) checks above pass, nothing warns, and anyone who has seen this repo can
// then forge a valid access/staff/partner token for any account — jsonwebtoken accepts any
// string as an HMAC key. So in production, refuse to boot when a secret looks like a
// placeholder rather than a generated value. Generate real ones with:
//   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
// and set them in the DigitalOcean App Platform dashboard, never in a file.
const PLACEHOLDER_SECRET = /replace_in_production|^dev[-_].*secret|changeme|^your[-_]/i;

if (result.data.NODE_ENV === 'production') {
  const placeholders = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'JWT_STAFF_SECRET',
    'JWT_PARTNER_SECRET',
  ].filter((key) => PLACEHOLDER_SECRET.test(result.data[key]));

  if (placeholders.length) {
    console.error(
      'Refusing to start in production — these secrets still hold a development placeholder value:'
    );
    for (const key of placeholders) console.error(`  ${key}`);
    process.exit(1);
  }

  // Without it, restaurants' bank account numbers can be neither stored nor read back.
  if (!result.data.DATA_ENCRYPTION_KEY) {
    console.error('Refusing to start in production — DATA_ENCRYPTION_KEY is not set (see DEPLOYMENT.md).');
    process.exit(1);
  }

  // Shortened session timings would close real customers' sessions within minutes.
  if (result.data.LIVE_ACTIVITY_TEST_TIMINGS) {
    console.error('Refusing to start in production — LIVE_ACTIVITY_TEST_TIMINGS is a local-only setting.');
    process.exit(1);
  }
}

// The production deploy is cross-site by construction — the portals are served from
// Vercel and this API from DigitalOcean, which are unrelated registrable domains — so a
// refresh cookie written with the 'lax' dev default is stored by the browser and then
// never sent back to POST /api/auth/refresh. Nothing errors: the access token in memory
// keeps working until it expires, then every screen starts failing 401 and the next page
// reload ends the session. Defaulting to 'none' in production removes that footgun;
// 'none' is also correct for a same-registrable-domain deploy, just less tight, and an
// explicit REFRESH_COOKIE_SAMESITE still wins if you have one.


export const env = {
  ...result.data,
  REFRESH_COOKIE_SAMESITE:
    result.data.REFRESH_COOKIE_SAMESITE ??
    (result.data.NODE_ENV === 'production' ? 'none' : 'lax'),
};
