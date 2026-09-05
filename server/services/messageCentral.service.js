import { redis } from '../config/redis.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { maskPhone } from '../utils/maskPhone.js';
import { ApiError } from '../utils/ApiError.js';

const AUTH_TOKEN_KEY = 'messagecentral:authtoken';
const AUTH_TOKEN_TTL_SECONDS = 5 * 24 * 60 * 60;

// Without a deadline a stalled provider call holds the Express request open until the
// platform's own proxy gives up — which is what turned "MessageCentral is out of credit"
// into a bare 504 with no log line naming a cause. 10s is well past MessageCentral's
// normal response time and well inside both the app's 20s HTTP client timeout and the
// gateway's 60s one, so a provider problem now surfaces as our own error, with a reason.
const PROVIDER_TIMEOUT_MS = 10_000;

if (
  env.SMS_PROVIDER === 'messagecentral' &&
  (!env.MESSAGECENTRAL_CUSTOMER_ID || !env.MESSAGECENTRAL_KEY || !env.MESSAGECENTRAL_EMAIL)
) {
  throw new Error(
    'SMS_PROVIDER=messagecentral requires MESSAGECENTRAL_CUSTOMER_ID, MESSAGECENTRAL_KEY, ' +
      'and MESSAGECENTRAL_EMAIL to be set'
  );
}

// MessageCentral reports failures in the body, not (only) the HTTP status, and the wording
// varies by endpoint. Everything the provider said is logged verbatim; this only decides
// which of two things the customer is told, since "we're out of credit" and "the SMS
// service is down" call for the same action from them but very different action from us.
const looksLikeQuotaProblem = (body) =>
  /balance|credit|insufficient|top.?up|quota|expired.*plan|limit exceeded/i.test(
    JSON.stringify(body ?? '')
  );

async function providerFetch(url, options, action) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    logger.error(
      { action, err: { name: err?.name, message: err?.message }, timedOut },
      timedOut
        ? 'MessageCentral request timed out before any response'
        : 'MessageCentral request failed at the network layer'
    );
    throw new ApiError(
      503,
      'SMS_PROVIDER_UNAVAILABLE',
      "We couldn't reach the SMS service. Please try again in a moment."
    );
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON bodies are almost always the interesting ones (an HTML error page from an
    // upstream proxy, a plain-text quota notice) — keep the raw text for the log.
    body = { raw: text.slice(0, 500) };
  }

  return { res, body };
}

function throwProviderError(action, res, body, context = {}) {
  const quota = looksLikeQuotaProblem(body);
  logger.error(
    { action, status: res.status, body, quota, ...context },
    quota
      ? 'MessageCentral rejected the request — looks like an account balance/quota problem'
      : 'MessageCentral request failed'
  );
  throw new ApiError(
    503,
    quota ? 'SMS_QUOTA_EXHAUSTED' : 'SMS_PROVIDER_ERROR',
    'SMS delivery is temporarily unavailable. Please try again shortly, or contact support if it keeps happening.'
  );
}

async function fetchAuthToken() {
  const url = new URL('/auth/v1/authentication/token', env.MESSAGECENTRAL_BASE_URL);
  url.searchParams.set('customerId', env.MESSAGECENTRAL_CUSTOMER_ID);
  url.searchParams.set('key', env.MESSAGECENTRAL_KEY);
  url.searchParams.set('scope', 'NEW');
  url.searchParams.set('country', '91');
  url.searchParams.set('email', env.MESSAGECENTRAL_EMAIL);

  const { res, body } = await providerFetch(url, { method: 'GET', headers: { accept: '*/*' } }, 'token');

  if (!res.ok || !body?.token) throwProviderError('token', res, body);

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

  const { res, body } = await providerFetch(url, { method: 'POST', headers: { authToken } }, 'send');
  const verificationId = body?.data?.verificationId;

  if (!res.ok || !verificationId) {
    throwProviderError('send', res, body, { phone: maskPhone(phone) });
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

  const { res, body } = await providerFetch(url, { method: 'GET', headers: { authToken } }, 'validate');

  // A wrong code is a normal outcome, not a provider fault: MessageCentral answers it with a
  // non-2xx and a verificationStatus rather than a 200, and treating that as an outage told
  // the customer the SMS service was down when all they had done was mistype a digit.
  const status = body?.data?.verificationStatus;
  if (status === 'VERIFICATION_FAILED' || status === 'VERIFICATION_EXPIRED') return false;

  if (!res.ok || !body?.data) throwProviderError('validate', res, body);

  return status === 'VERIFICATION_COMPLETED';
}
