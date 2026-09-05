import argon2 from 'argon2';
import crypto from 'crypto';
import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { maskPhone } from '../utils/maskPhone.js';
import { ApiError } from '../utils/ApiError.js';
import * as messageCentralService from './messageCentral.service.js';

const OTP_TTL_SECONDS = 5 * 60;
const REQUEST_WINDOW_SECONDS = 10 * 60;
const MAX_VERIFY_ATTEMPTS = 5;

const otpKey = (phone) => `otp:${phone}`;
const otpRequestCountKey = (phone) => `otp:reqcount:${phone}`;

const generateSixDigitCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// TEMPORARY — see config/env.js. The MessageCentral balance is exhausted, so rather than
// every login dying on a provider call that cannot succeed, SMS_PROVIDER=bypass skips the
// provider entirely and accepts any six-digit code for a number that has requested one.
// Everything else about the flow is unchanged (a code must still be requested first, it
// still expires after five minutes, the rate limits still apply), so the app exercises the
// real login path. Revert by setting SMS_PROVIDER=messagecentral — no code change needed.
const isBypass = env.SMS_PROVIDER === 'bypass';

if (isBypass) {
  logger.warn(
    'SMS_PROVIDER=bypass — OTP verification is DISABLED. No SMS is sent and any 6-digit ' +
      'code will sign a customer in. Set SMS_PROVIDER=messagecentral to restore real OTP.'
  );
}

// SMS_PROVIDER=mock (dev default) generates and hashes the code locally, same as before
// messageCentral.service.js existed. SMS_PROVIDER=messagecentral delegates OTP generation and
// delivery to MessageCentral and stores its verificationId instead of a local hash.
// SMS_PROVIDER=bypass stores neither and accepts anything — see the note above.
export const requestOtp = async (phone) => {
  const requestCount = await redis.incr(otpRequestCountKey(phone));
  if (requestCount === 1) {
    await redis.expire(otpRequestCountKey(phone), REQUEST_WINDOW_SECONDS);
  }
  if (requestCount > env.OTP_MAX_REQUESTS_PER_WINDOW) {
    logger.info(
      { phone: maskPhone(phone), requestCount },
      'OTP send rate limit hit for this number'
    );
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Too many OTP requests for this number. Please wait a few minutes and try again.'
    );
  }

  if (isBypass) {
    await redis.set(
      otpKey(phone),
      JSON.stringify({ bypass: true, attempts: 0 }),
      'EX',
      OTP_TTL_SECONDS
    );
    logger.warn(
      { phone: maskPhone(phone) },
      'OTP bypass active — no SMS sent, any 6-digit code will verify this number'
    );
    // The app surfaces this so the customer is told the code is not coming, instead of
    // waiting out the resend timer for an SMS that will never arrive.
    return { phone, otpBypass: true };
  }

  if (env.SMS_PROVIDER === 'messagecentral') {
    const verificationId = await messageCentralService.sendSms(phone);
    await redis.set(
      otpKey(phone),
      JSON.stringify({ verificationId, attempts: 0 }),
      'EX',
      OTP_TTL_SECONDS
    );
    logger.info({ phone: maskPhone(phone) }, 'OTP SMS sent via MessageCentral');
    return { phone };
  }

  const code = generateSixDigitCode();
  const hash = await argon2.hash(code, { type: argon2.argon2id });
  await redis.set(otpKey(phone), JSON.stringify({ hash, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

  if (env.NODE_ENV !== 'production') {
    logger.info({ phone, code }, 'Dev-mode OTP generated (no SMS provider configured)');
    return { phone, devOtp: code };
  }

  return { phone };
};

export const verifyOtp = async (phone, code) => {
  const raw = await redis.get(otpKey(phone));
  if (!raw) {
    throw new ApiError(
      400,
      'OTP_EXPIRED',
      'That code has expired or was never requested. Please request a new one.'
    );
  }

  const entry = JSON.parse(raw);
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    await redis.del(otpKey(phone));
    throw new ApiError(
      400,
      'OTP_LOCKED',
      'Too many incorrect attempts. Please request a new code.'
    );
  }

  let valid;
  if (isBypass) {
    // Deliberately ignores the stored entry's shape: a code requested just before the
    // switch to bypass carries a MessageCentral verificationId, and validating it would
    // make exactly the provider call this mode exists to avoid.
    valid = /^\d{6}$/.test(code);
    logger.warn({ phone: maskPhone(phone), valid }, 'OTP verified via bypass (no provider call)');
  } else if (entry.bypass) {
    // Left over from a bypass window that has since been turned off — it carries no secret
    // to check against, so the only safe answer is to make them request a real code.
    await redis.del(otpKey(phone));
    throw new ApiError(
      400,
      'OTP_EXPIRED',
      'That code is no longer valid. Please request a new one.'
    );
  } else if (entry.verificationId) {
    valid = await messageCentralService.validateSms(entry.verificationId, code);
  } else {
    valid = await argon2.verify(entry.hash, code);
  }

  if (!valid) {
    entry.attempts += 1;
    const attemptsLeft = MAX_VERIFY_ATTEMPTS - entry.attempts;
    if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
      await redis.del(otpKey(phone));
      throw new ApiError(
        400,
        'OTP_LOCKED',
        'Too many incorrect attempts. Please request a new code.'
      );
    }

    await redis.set(otpKey(phone), JSON.stringify(entry), 'KEEPTTL');
    // The count is what turns a vague "wrong code" into something the customer can act on
    // before they get locked out and have to start over.
    throw new ApiError(
      400,
      'INVALID_OTP',
      `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left before you'll need a new one.`,
      { attemptsLeft }
    );
  }

  await redis.del(otpKey(phone));
};
