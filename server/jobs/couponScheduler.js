import { redis as defaultRedis } from '../config/redis.js';
import { expireDue, runSellerReminders, runAdminCampaigns, istDay } from '../services/couponReminders.service.js';
import { isTemplateSmsLive } from '../services/sms/templateSender.js';
import logger from '../utils/logger.js';

// The coupon system's daily jobs (§ CB10), on India time:
//   02:00  expiry     issued coupons past their date → expired
//   10:00  reminders  expiry-reminder SMS: every seller with credits, then queued admin campaigns
//
// Same shape as jobs/settlementScheduler.js: a tick every 10 minutes, so a deploy or restart near
// the hour doesn't miss a run; each job runs once per IST day — a Redis lock lets exactly one
// instance run it and a "done" marker stops the rest (and later ticks). No Redis, or Redis
// unreachable: skipped and logged rather than risking every instance at once. The work is safe to
// repeat anyway (expiry is one updateMany; each SMS is claimed by a unique log row first).
//
// Reminders are skipped entirely while template SMS can't really be delivered
// (services/sms/templateSender.js#isTemplateSmsLive) — no seller credit is spent on a fake send.

const TICK_MS = 10 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;
const LOCK_TTL_SECONDS = 30 * 60;
const DONE_TTL_SECONDS = 3 * 24 * 60 * 60;

export const COUPON_JOBS = Object.freeze({
  expiry: { hourIst: 2, run: (now) => expireDue(now).then((expired) => ({ expired })) },
  reminders: {
    hourIst: 10,
    run: async (now) => ({ sellers: await runSellerReminders(now), campaigns: await runAdminCampaigns(now) }),
  },
});

const istHour = (now) => new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();

const runJob = async (name, { now, redis }) => {
  const job = COUPON_JOBS[name];
  if (istHour(now) < job.hourIst) return 'not_due';
  if (name === 'reminders' && !isTemplateSmsLive()) return 'sms_not_live';

  const day = istDay(now);
  const doneKey = `coupon:${name}:done:${day}`;
  const lockKey = `lock:coupon:${name}:${day}`;
  try {
    if (!redis || redis.status === 'end') {
      logger.warn({ job: name }, 'Coupon scheduler: Redis unavailable — skipping');
      return 'no_redis';
    }
    if (await redis.get(doneKey)) return 'already_done';
    const acquired = await redis.set(lockKey, process.pid.toString(), 'EX', LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return 'locked';
  } catch (err) {
    logger.warn({ err, job: name }, 'Coupon scheduler: Redis error — skipping this tick');
    return 'no_redis';
  }

  try {
    const result = await job.run(now);
    await redis.set(doneKey, '1', 'EX', DONE_TTL_SECONDS);
    logger.info({ job: name, day, result }, 'Coupon job done');
    return 'ran';
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
};

/**
 * One tick: each job that is due today and not yet done. Exported (Redis and clock injectable)
 * for tests. Returns { expiry, reminders }, each 'not_due' | 'sms_not_live' | 'no_redis' |
 * 'already_done' | 'locked' | 'ran'.
 */
export const runCouponTick = async ({ now = new Date(), redis = defaultRedis } = {}) => {
  const out = {};
  for (const name of Object.keys(COUPON_JOBS)) {
    try {
      out[name] = await runJob(name, { now, redis });
    } catch (err) {
      logger.error({ err, job: name }, 'Coupon job failed — retried next tick');
      out[name] = 'failed';
    }
  }
  return out;
};

/** Starts the ticks (1 minute after boot, then every 10). Returns { stop } like the settlement scheduler. */
export const startCouponScheduler = () => {
  let running = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return running;
    running = runCouponTick()
      .catch((err) => logger.error({ err }, 'Coupon scheduler tick failed'))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const first = setTimeout(tick, 60 * 1000);
  const every = setInterval(tick, TICK_MS);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      await running;
    },
  };
};
