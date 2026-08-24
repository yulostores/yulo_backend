import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';

const AUTH_TOKEN_KEY = 'messagecentral:authtoken';
const AUTH_TOKEN_TTL_SECONDS = 5 * 24 * 60 * 60;

if (
  env.SMS_PROVIDER === 'messagecentral' &&
  (!env.MESSAGECENTRAL_CUSTOMER_ID || !env.MESSAGECENTRAL_KEY || !env.MESSAGECENTRAL_EMAIL)
) {
  throw new Error(
    'SMS_PROVIDER=messagecentral requires MESSAGECENTRAL_CUSTOMER_ID, MESSAGECENTRAL_KEY, ' +
      'and MESSAGECENTRAL_EMAIL to be set'
  );
}

async function fetchAuthToken() {
  const url = new URL('/auth/v1/authentication/token', env.MESSAGECENTRAL_BASE_URL);
  url.searchParams.set('customerId', env.MESSAGECENTRAL_CUSTOMER_ID);
  url.searchParams.set('key', env.MESSAGECENTRAL_KEY);
  url.searchParams.set('scope', 'NEW');
  url.searchParams.set('country', '91');
  url.searchParams.set('email', env.MESSAGECENTRAL_EMAIL);

  const res = await fetch(url, { method: 'GET', headers: { accept: '*/*' } });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.token) {
    logger.error({ status: res.status, body }, 'MessageCentral token generation failed');
    throw new ApiError(502, 'SMS_PROVIDER_ERROR', 'Failed to authenticate with SMS provider');
  }

  return body.token;
}

// Token generation (scope=NEW) is a paid/rate-limited call on MessageCentral's side and the
// token is long-lived, so it's cached in Redis rather than re-fetched per OTP send.
export async function getAuthToken() {
  const cached = await redis.get(AUTH_TOKEN_KEY);
  if (cached) return cached;

  const token = await fetchAuthToken();
  await redis.set(AUTH_TOKEN_KEY, token, 'EX', AUTH_TOKEN_TTL_SECONDS);
  return token;
}

export async function sendSms(phone) {
  const authToken = await getAuthToken();

  const url = new URL('/verification/v3/send', env.MESSAGECENTRAL_BASE_URL);
  url.searchParams.set('countryCode', '91');
  url.searchParams.set('flowType', 'SMS');
  url.searchParams.set('mobileNumber', phone);
  url.searchParams.set('otpLength', '6');

  const res = await fetch(url, { method: 'POST', headers: { authToken } });
  const body = await res.json().catch(() => null);
  const verificationId = body?.data?.verificationId;

  if (!res.ok || !verificationId) {
    logger.error({ status: res.status, body }, 'MessageCentral send OTP failed');
    throw new ApiError(502, 'SMS_PROVIDER_ERROR', 'Failed to send OTP SMS');
  }

  return verificationId;
}

// NOTE: response field names below (`data.verificationStatus` / 'VERIFICATION_COMPLETED') follow
// MessageCentral's documented v3 verify response shape, but the Postman collection this was
// modeled on didn't capture a saved response body — confirm against a real call (Step 8 of
// prompt.md) before relying on this in production, and adjust the check below if the actual
// field names differ.
export async function validateSms(verificationId, code) {
  const authToken = await getAuthToken();

  const url = new URL('/verification/v3/validateOtp', env.MESSAGECENTRAL_BASE_URL);
  url.searchParams.set('verificationId', verificationId);
  url.searchParams.set('code', code);
  url.searchParams.set('flowType', 'SMS');

  const res = await fetch(url, { method: 'GET', headers: { authToken } });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.data) {
    logger.error({ status: res.status, body }, 'MessageCentral validate OTP failed');
    throw new ApiError(502, 'SMS_PROVIDER_ERROR', 'Failed to validate OTP with SMS provider');
  }

  return body.data.verificationStatus === 'VERIFICATION_COMPLETED';
}
