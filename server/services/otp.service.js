import argon2 from 'argon2';
import crypto from 'crypto';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';

const OTP_TTL_SECONDS = 5 * 60;
const REQUEST_WINDOW_SECONDS = 10 * 60;
const MAX_REQUESTS_PER_WINDOW = 3;
const MAX_VERIFY_ATTEMPTS = 5;

const otpKey = (phone) => `otp:${phone}`;
const otpRequestCountKey = (phone) => `otp:reqcount:${phone}`;

const generateSixDigitCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// No SMS provider exists anywhere in this codebase (no Twilio/MSG91/etc in package.json). This
// module is the seam where a real provider call replaces the dev-mode log/return below, without
// changing the requestOtp/verifyOtp contract the controller depends on.
export const requestOtp = async (phone) => {
  const requestCount = await redis.incr(otpRequestCountKey(phone));
  if (requestCount === 1) {
    await redis.expire(otpRequestCountKey(phone), REQUEST_WINDOW_SECONDS);
  }
  if (requestCount > MAX_REQUESTS_PER_WINDOW) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many OTP requests — try again later');
  }

  const code = generateSixDigitCode();
  const hash = await argon2.hash(code, { type: argon2.argon2id });
  await redis.set(otpKey(phone), JSON.stringify({ hash, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

  if (env.NODE_ENV !== 'production') {
    logger.info({ phone, code }, 'Dev-mode OTP generated (no SMS provider configured)');
    return { phone, devOtp: code };
  }

  // TODO: send `code` via a real SMS provider here once one is integrated.
  return { phone, devOtp: code };
};

export const verifyOtp = async (phone, code) => {
  const raw = await redis.get(otpKey(phone));
  if (!raw) {
    throw new ApiError(400, 'OTP_EXPIRED', 'OTP expired or not requested — request a new one');
  }

  const entry = JSON.parse(raw);
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    await redis.del(otpKey(phone));
    throw new ApiError(400, 'OTP_LOCKED', 'Too many incorrect attempts — request a new OTP');
  }

  const valid = await argon2.verify(entry.hash, code);
  if (!valid) {
    entry.attempts += 1;
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
      await redis.del(otpKey(phone));
    } else {
      await redis.set(otpKey(phone), JSON.stringify(entry), 'KEEPTTL');
    }
    throw new ApiError(400, 'INVALID_OTP', 'Incorrect OTP');
  }

  await redis.del(otpKey(phone));
};
