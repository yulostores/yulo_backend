import { redis as defaultRedis } from '../config/redis.js';
import { getActiveSettings } from '../services/financeSettings.service.js';
import { generateWeeklySettlements, previousWeekStart } from '../services/settlement.service.js';
import { weekBounds } from '../utils/week.js';
import logger from '../utils/logger.js';

// Generates last week's restaurant settlements once the new week is a few hours old — Monday
// 03:00 in the settlement time zone (Asia/Kolkata), after the last Sunday-night orders have
// been delivered. Checks every 10 minutes, so a deploy or restart around 03:00 doesn't miss it.
//
// With several server instances each running this, a Redis lock lets exactly one generate; a
// "done" marker stops the others (and later ticks) repeating it. Generation is idempotent in the
// database anyway — the lock just avoids the duplicate work. No Redis, or Redis unreachable:
// the tick is skipped and logged rather than risking every instance running at once; an admin
// can always generate from the console (POST /api/admin/finance/settlements/generate).

const TICK_MS = 10 * 60 * 1000;
const RUN_AFTER_MS = 3 * 60 * 60 * 1000; // 03:00 on the first day of the week
const LOCK_TTL_SECONDS = 30 * 60;
const DONE_TTL_SECONDS = 9 * 24 * 60 * 60;

/**
 * One scheduler tick. Exported (with injectable Redis/generator/clock) for tests.
 * Returns 'not_due' | 'already_done' | 'locked' | 'no_redis' | 'generated'.
 */
export const runSettlementTick = async ({
  now = new Date(),
  redis = defaultRedis,
  generate = generateWeeklySettlements,
} = {}) => {
  const { settlementCycle } = await getActiveSettings();
  const thisWeekStart = weekBounds(now, settlementCycle).start;
  if (now.getTime() < thisWeekStart.getTime() + RUN_AFTER_MS) return 'not_due';

  const target = previousWeekStart(now, settlementCycle);
  const doneKey = `settlement:generated:${target.toISOString()}`;
  const lockKey = `lock:settlement:${target.toISOString()}`;

  try {
    if (!redis || redis.status === 'end') {
      logger.warn('Settlement scheduler: Redis unavailable — skipping (generate from the admin console if needed)');
      return 'no_redis';
    }
    if (await redis.get(doneKey)) return 'already_done';
    const acquired = await redis.set(lockKey, process.pid.toString(), 'EX', LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') return 'locked';
  } catch (err) {
    logger.warn({ err }, 'Settlement scheduler: Redis error — skipping this tick');
    return 'no_redis';
  }

  try {
    const result = await generate(target);
    await redis.set(doneKey, '1', 'EX', DONE_TTL_SECONDS);
    logger.info(
      { periodStart: result.periodStart, settlements: result.settlements.length },
      'Weekly restaurant settlements generated'
    );
    return 'generated';
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
};

/**
 * Starts the ticks: shortly after boot, then every TICK_MS. Returns { stop } — stop() cancels
 * future ticks and resolves once a tick already running has finished, so a shutdown doesn't
 * cut a generation off mid-way (it would recover — locks expire — but cleanly is better).
 */
export const startSettlementScheduler = () => {
  let running = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return running;
    running = runSettlementTick()
      .catch((err) => logger.error({ err }, 'Settlement scheduler tick failed'))
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
