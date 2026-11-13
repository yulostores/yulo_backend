import crypto from 'crypto';
import { env } from '../../config/env.js';
import logger from '../../utils/logger.js';
import { maskPhone } from '../../utils/maskPhone.js';
import { ApiError } from '../../utils/ApiError.js';

// Template SMS — the coupon-expiry reminders (§ CB10). Separate from OTP delivery
// (services/otp.service.js / messageCentral.service.js), which uses Message Central's
// verification API and has no free-text or template messages.
//
// In India every non-OTP business SMS must use a DLT-registered template (sender id + template
// id, text matching the registered template). Providers, chosen by SMS_TEMPLATE_PROVIDER:
//
//   mock            Sends nothing. Records each message in memory (the last 500, for tests and
//                   local runs) and logs it — with the phone MASKED, always.
//   messagecentral  NOT BUILT YET. Message Central says its India SMS API supports DLT transactional
//                   routes, but its request format for a template send (template-id and sender-id
//                   field names, endpoint) is not in the documentation available to us. TODO: get the
//                   "send SMS with DLT template" API reference from Message Central, register the
//                   reminder template on the DLT portal, then implement sendViaMessageCentral below.
//                   Until then it refuses (SMS_TEMPLATE_PROVIDER_NOT_READY) rather than pretend.
//
// Tests always get the mock, whatever the environment says.
//
// isTemplateSmsLive() says whether messages really reach phones. The reminder scheduler and the
// credit shop check it, so in production no seller credit is spent — or sold — before then.

const MOCK_OUTBOX_LIMIT = 500;
const outbox = [];

const providerName = () => (env.NODE_ENV === 'test' ? 'mock' : env.SMS_TEMPLATE_PROVIDER);

const sendViaMock = async (phone, templateId, vars) => {
  const message = { id: `mock_${crypto.randomBytes(8).toString('hex')}`, to: maskPhone(phone), templateId, vars, at: new Date() };
  outbox.push(message);
  if (outbox.length > MOCK_OUTBOX_LIMIT) outbox.shift();
  logger.info({ to: message.to, templateId, messageId: message.id }, 'Template SMS (mock provider — not sent)');
  return { provider: 'mock', messageId: message.id };
};

// eslint-disable-next-line no-unused-vars
const sendViaMessageCentral = async (phone, templateId, vars) => {
  // TODO(CB10): implement once Message Central's DLT template-send API is confirmed (see top).
  throw new ApiError(503, 'SMS_TEMPLATE_PROVIDER_NOT_READY', 'Reminder SMS are not available yet');
};

/**
 * Sends one template SMS. `vars` fills the template's variables in order of the registered text.
 * Resolves { provider, messageId }; rejects on a provider failure (the caller marks that message
 * failed and refunds its credit).
 */
export const sendTemplate = async (phone, templateId, vars = {}) => {
  if (!/^\d{10}$/.test(String(phone ?? ''))) throw new ApiError(400, 'INVALID_PHONE', 'Not a 10-digit mobile number');
  if (sendOverride) return sendOverride(phone, templateId, vars);
  if (providerName() === 'messagecentral') return sendViaMessageCentral(phone, templateId, vars);
  return sendViaMock(phone, templateId, vars);
};

/** Whether template SMS actually reach phones. False for the mock in production (and for now, everywhere real). */
export const isTemplateSmsLive = () => {
  if (env.NODE_ENV === 'production') return false; // no real provider is built yet — see the TODO above
  return true; // development and tests: the mock stands in, nothing is charged for real
};

/** The reminder's DLT template id. */
export const reminderTemplateId = () => env.SMS_REMINDER_TEMPLATE_ID ?? 'coupon_expiry_reminder';

// ── Mock provider, for tests and local runs ───────────────────────────────────
let sendOverride = null;
/** Tests only: replace the provider (e.g. one that fails); null restores it. */
export const __setSendOverrideForTests = (fn) => {
  sendOverride = env.NODE_ENV === 'test' ? fn : null;
};
export const __mockOutbox = () => outbox.slice();
export const __clearMockOutbox = () => {
  outbox.length = 0;
};
