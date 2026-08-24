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

export const env = result.data;
