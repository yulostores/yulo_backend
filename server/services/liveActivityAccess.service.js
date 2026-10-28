// Which restaurants live customer activity is on for — a super admin's per-restaurant choice
// (Restaurant.liveActivityEnabled), on top of the server-wide LIVE_ACTIVITY_ENABLED switch.
//
// The request-time check (isLiveActivityEnabledFor in config/liveActivity.config.js) reads an
// in-memory set so it never waits on the database. This service fills that set: at boot, after
// every toggle on this instance, and every ACCESS_REFRESH_MS so other instances catch up with a
// toggle made elsewhere. With the switch off nothing is read at all.

import Restaurant from '../models/Restaurant.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import { logActivity } from './activityLog.service.js';
import {
  isLiveActivityEnabled,
  markLiveActivityRestaurant,
  setLiveActivityRestaurants,
} from '../config/liveActivity.config.js';

export const ACCESS_REFRESH_MS = 30_000;

/** Re-reads the restaurants the feature is on for. Never throws: a failed read keeps the last set. */
export const loadLiveActivityRestaurants = async () => {
  if (!isLiveActivityEnabled()) return;
  try {
    const rows = await Restaurant.find({ liveActivityEnabled: true }).select('_id').lean();
    setLiveActivityRestaurants(rows.map((r) => r._id));
  } catch (err) {
    logger.warn({ err }, 'Could not read live activity restaurants — keeping the last list');
  }
};

/** Starts the periodic re-read; returns a stop function. The timer never holds the process open. */
export const startLiveActivityAccessRefresh = () => {
  const timer = setInterval(() => void loadLiveActivityRestaurants(), ACCESS_REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * A super admin turns the feature on or off for one restaurant. Audit-logged; applied on this
 * instance at once. Returns `{ enabled, serverEnabled }` — `serverEnabled` false means the
 * choice is saved but nothing runs until LIVE_ACTIVITY_ENABLED is on.
 */
export const setRestaurantLiveActivity = async ({ restaurantId, enabled, adminId }) => {
  const store = await Restaurant.findById(restaurantId).select('+liveActivityEnabled');
  if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found');

  if (Boolean(store.liveActivityEnabled) !== enabled) {
    await Restaurant.updateOne({ _id: store._id }, { $set: { liveActivityEnabled: enabled } });
    await logActivity({
      adminId,
      action: enabled ? 'STORE_LIVE_ACTIVITY_ENABLED' : 'STORE_LIVE_ACTIVITY_DISABLED',
      targetType: 'restaurant',
      targetId: store._id,
    });
  }
  markLiveActivityRestaurant(store._id, enabled);
  return { enabled, serverEnabled: isLiveActivityEnabled() };
};
