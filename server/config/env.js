import 'dotenv/config';
import { z } from 'zod';

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
  JWT_STAFF_EXPIRES: z.string().default('8h'),
  JWT_PARTNER_ACCESS_EXPIRES: z.string().default('15m'),
  JWT_PARTNER_REFRESH_EXPIRES: z.string().default('30d'),
  CLOUDINARY_URL: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
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
  PLATFORM_COMMISSION_PERCENT: z.coerce.number().default(15),
  DELIVERY_PARTNER_PER_DELIVERY_RATE: z.coerce.number().default(30),
  DELIVERY_PARTNER_MAX_CONCURRENT_ORDERS: z.coerce.number().default(1),
  DELIVERY_OFFER_WINDOW_SECONDS: z.coerce.number().default(20),
  DELIVERY_PARTNER_PER_KM_RATE: z.coerce.number().default(5),
  CART_PLATFORM_FEE: z.coerce.number().default(6),
  CART_TAX_PERCENT: z.coerce.number().default(5),
  MESSAGECENTRAL_CUSTOMER_ID: z.string().optional(),
  MESSAGECENTRAL_KEY: z.string().optional(),
  MESSAGECENTRAL_EMAIL: z.string().email().optional(),
  MESSAGECENTRAL_BASE_URL: z.string().url().default('https://cpaas.messagecentral.com'),
  SMS_PROVIDER: z.enum(['mock', 'messagecentral']).default('mock'),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment variables:');
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
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
