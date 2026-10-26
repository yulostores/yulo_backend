// Push notifications to the rider app, sent through Expo's push service to the token the app
// registered (DeliveryPartner.pushToken — PUT /api/partner/notifications/push-token).
//
// The socket stays the fast path while the app is open. A push is what reaches a rider whose
// phone is locked or whose app is in the background: Android closes the socket within moments
// of that, so an offer sent only over the socket was never seen.
//
// Best-effort and never throws — a push that fails must not fail the offer or cancellation it
// goes with. Tests never reach Expo: under NODE_ENV=test the sender only records
// (__setPushSenderForTests swaps it).

import DeliveryPartner from '../models/DeliveryPartner.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SEND_TIMEOUT_MS = 10_000;

export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

// Android notification channels the rider app creates (delivery_partner_mobile
// src/lib/pushNotifications.js) — the importance and sound live on the channel, not the message.
export const PUSH_CHANNELS = { offers: 'order-offers', updates: 'order-updates' };

const expoSender = async (messages) => {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Expo push answered ${res.status}`);
  return Array.isArray(body?.data) ? body.data : [];
};

const recordingSender = async (messages) => messages.map(() => ({ status: 'ok' }));

let sender = env.NODE_ENV === 'test' ? recordingSender : expoSender;

export const __setPushSenderForTests = (fn) => {
  sender = fn ?? recordingSender;
};

/**
 * Sends one notification to a rider's phone. `kind` is the rider's notification preference that
 * governs it (DeliveryPartner.notificationPreferences) — a rider who switched it off gets nothing.
 * Resolves true when Expo accepted it; false when there was nothing to send to or it failed.
 */
export const pushToPartner = async (
  partnerId,
  { title, body, data = {}, channelId = PUSH_CHANNELS.updates, ttlSeconds = null, kind = 'orders' }
) => {
  try {
    const partner = await DeliveryPartner.findById(partnerId).select('pushToken notificationPreferences').lean();
    const token = partner?.pushToken;
    if (!token) return false;
    if (partner.notificationPreferences?.[kind] === false) return false;

    const [ticket] = await sender([
      {
        to: token,
        title,
        body,
        data,
        channelId,
        priority: 'high',
        ...(partner.notificationPreferences?.soundVibration === false ? {} : { sound: 'default' }),
        // An offer is worthless once its window has closed — don't deliver it late.
        ...(ttlSeconds ? { ttl: ttlSeconds } : {}),
      },
    ]);
    if (ticket?.status === 'error') {
      if (ticket.details?.error === 'DeviceNotRegistered') {
        // The app was uninstalled or the token rotated: stop sending to it.
        await DeliveryPartner.updateOne({ _id: partnerId, pushToken: token }, { $set: { pushToken: null } });
      }
      logger.warn({ partnerId, error: ticket.details?.error, message: ticket.message }, 'Rider push refused');
      return false;
    }
    return ticket?.status === 'ok';
  } catch (err) {
    logger.warn({ err, partnerId }, 'Rider push failed');
    return false;
  }
};
