// Preloaded into every test process by `npm test` (node --import ./test-utils/testEnv.mjs --test).
// NOT under test/ on purpose, so `node --test` doesn't run it as a test file.
//
// config/env.js does `import 'dotenv/config'`, which would otherwise load the developer's
// real server/.env into every test: live Razorpay keys, the real MongoDB URI, the real Redis.
// No test may ever reach those. So:
//   1. point dotenv at an empty file (dotenv/config honours DOTENV_CONFIG_PATH), and
//   2. drop anything sensitive the shell itself may have exported,
//   3. fill in the throwaway values config/env.js's schema demands.
// A test that needs a gateway key or a flag sets process.env itself before it imports the app.

import { fileURLToPath } from 'node:url';

process.env.DOTENV_CONFIG_PATH = fileURLToPath(new URL('./empty.env', import.meta.url));

for (const key of [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'REDIS_URL',
  'MONGODB_URI',
  'CLOUDINARY_URL',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'MESSAGECENTRAL_KEY',
  'SENTRY_DSN',
  'ALLOW_PAYMENT_SIMULATION',
  'COD_ENABLED',
  'DATA_ENCRYPTION_KEY',
]) {
  delete process.env[key];
}

const THROWAWAY_SECRET = 'test-only-not-a-real-secret-000000000000';
process.env.NODE_ENV ??= 'test';
// Never connected to by anything that doesn't override it — DB tests use mongodb-memory-server
// (test-utils/memoryMongo.mjs).
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-connected';
process.env.JWT_ACCESS_SECRET = THROWAWAY_SECRET;
process.env.JWT_REFRESH_SECRET = `${THROWAWAY_SECRET}-refresh`;
process.env.JWT_STAFF_SECRET = `${THROWAWAY_SECRET}-staff`;
process.env.JWT_PARTNER_SECRET = `${THROWAWAY_SECRET}-partner`;
process.env.LOG_LEVEL ??= 'silent';
// A throwaway field-encryption key (32 bytes of 0x01) — test data only, never a real key.
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
