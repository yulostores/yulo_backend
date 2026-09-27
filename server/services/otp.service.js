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

// `scope` keeps one audience's codes apart from another's. Customers and delivery partners
// share the unscoped keys (unchanged, so codes already in flight keep working); staff pass
// scope 'staff:<restaurantId>' (controllers/staff/auth.controller.js), so a code requested
// for a customer login on a number can never complete a staff login on the same number,
// and a staff code for one restaurant can't sign that number in at another.
const scoped = (scope, phone) => (scope ? `${scope}:${phone}` : phone);
const otpKey = (phone, scope) => `otp:${scoped(scope, phone)}`;
const otpRequestCountKey = (phone, scope) => `otp:reqcount:${scoped(scope, phone)}`;
// Wrong guesses against the code currently pending for this number. Its own counter so it
// can be bumped atomically (INCR): kept inside the code's JSON, parallel guesses each read
// the same count and wrote it back, so a burst of requests got far more than
// MAX_VERIFY_ATTEMPTS tries.
const otpAttemptsKey = (phone, scope) => `otp:attempts:${scoped(scope, phone)}`;

const lockedError = () =>
  new ApiError(400, 'OTP_LOCKED', 'Too many incorrect attempts. Please request a new code.');
const expiredError = (message = 'That code has expired or was never requested. Please request a new one.') =>
  new ApiError(400, 'OTP_EXPIRED', message);

// Redis is the only place a pending OTP lives, so without it this flow cannot work at all
// — and it fails on the very first statement of requestOtp(). config/redis.js exports
// `null` when REDIS_URL is unset, which made that a bare TypeError: no usable status, no
// log line naming Redis, and a response the app could only render as "something went
// wrong". Name the real cause instead, so it shows up in both the logs and the app.
const requireRedis = () => {
  if (!redis) {
    logger.error('OTP requested but REDIS_URL is not configured — OTP cannot work without it');
    throw new ApiError(
      503,
      'OTP_STORE_UNAVAILABLE',
      'Login is temporarily unavailable. Please try again in a few minutes.'
    );
  }
};

// Same reasoning for a Redis that is configured but unreachable (wrong URL, firewall, the
// instance asleep): the command rejects with a driver error that means nothing to a
// customer and, unlogged, nothing to us either.
const withRedis = async (operation, action) => {
  requireRedis();
  try {
    return await operation();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.error({ action, err: { name: err?.name, message: err?.message } }, 'Redis command failed during OTP flow');
    throw new ApiError(
      503,
      'OTP_STORE_UNAVAILABLE',
      'Login is temporarily unavailable. Please try again in a few minutes.'
    );
  }
};

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
      'code will sign in a customer, delivery partner or restaurant staff member. Set ' +
      'SMS_PROVIDER=messagecentral to restore real OTP.'
  );
}

// SMS_PROVIDER=mock (dev default) generates and hashes the code locally, same as before
// messageCentral.service.js existed. SMS_PROVIDER=messagecentral delegates OTP generation and
// delivery to MessageCentral and stores its verificationId instead of a local hash.
// SMS_PROVIDER=bypass stores neither and accepts anything — see the note above.
//
// `send: false` spends the number's request budget (and hits the same 429) but stores and
// sends nothing. The staff login uses it for numbers that aren't staff, so the rate limit
// behaves identically for every number and can't be used to tell which ones are.
export const requestOtp = async (phone, { scope = null, send = true } = {}) => {
  const requestCount = await withRedis(
    () => redis.incr(otpRequestCountKey(phone, scope)),
    'incr-request-count'
  );
  if (requestCount === 1) {
    await withRedis(
      () => redis.expire(otpRequestCountKey(phone, scope), REQUEST_WINDOW_SECONDS),
      'expire-request-count'
    );
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

  if (!send) return { phone, ...(isBypass ? { otpBypass: true } : {}) };

  // A fresh code starts with a fresh allowance of guesses.
  await withRedis(() => redis.del(otpAttemptsKey(phone, scope)), 'reset-attempts');

  if (isBypass) {
    await redis.set(
      otpKey(phone, scope),
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
      otpKey(phone, scope),
      JSON.stringify({ verificationId, attempts: 0 }),
      'EX',
      OTP_TTL_SECONDS
    );
    logger.info({ phone: maskPhone(phone) }, 'OTP SMS sent via MessageCentral');
    return { phone };
  }

  const code = generateSixDigitCode();
  const hash = await argon2.hash(code, { type: argon2.argon2id });
  await redis.set(otpKey(phone, scope), JSON.stringify({ hash, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

  if (env.NODE_ENV !== 'production') {
    logger.info({ phone, code }, 'Dev-mode OTP generated (no SMS provider configured)');
    return { phone, devOtp: code };
  }

  return { phone };
};

export const verifyOtp = async (phone, code, { scope = null } = {}) => {
  const key = otpKey(phone, scope);
  const attemptsKey = otpAttemptsKey(phone, scope);
  const discard = () => redis.del(key, attemptsKey);

  const raw = await withRedis(() => redis.get(key), 'get-otp');
  if (!raw) throw expiredError();

  // Counted before the code is checked, atomically, so every guess — however many arrive at
  // once — uses up one of the allowance.
  const attempt = await withRedis(() => redis.incr(attemptsKey), 'incr-attempts');
  if (attempt === 1) await redis.expire(attemptsKey, OTP_TTL_SECONDS);

  const entry = JSON.parse(raw);
  // `entry.attempts` is the old in-entry counter, still set on codes requested before this
  // change; honour it so those can't be guessed past the limit either.
  const used = Math.max(attempt, (entry.attempts ?? 0) + 1);
  if (used > MAX_VERIFY_ATTEMPTS) {
    await discard();
    throw lockedError();
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
    await discard();
    throw expiredError('That code is no longer valid. Please request a new one.');
  } else if (entry.verificationId) {
    valid = await messageCentralService.validateSms(entry.verificationId, code);
  } else {
    valid = await argon2.verify(entry.hash, code);
  }

  if (!valid) {
    const attemptsLeft = MAX_VERIFY_ATTEMPTS - used;
    if (attemptsLeft <= 0) {
      await discard();
      throw lockedError();
    }
    // The count is what turns a vague "wrong code" into something the customer can act on
    // before they get locked out and have to start over.
    throw new ApiError(
      400,
      'INVALID_OTP',
      `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left before you'll need a new one.`,
      { attemptsLeft }
    );
  }

  // Single use: of two requests carrying the right code at the same moment, only the one
  // whose delete actually removed it succeeds.
  const removed = await withRedis(() => redis.del(key), 'consume-otp');
  await redis.del(attemptsKey);
  if (!removed) throw expiredError();
};
