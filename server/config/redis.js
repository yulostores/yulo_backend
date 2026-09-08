import Redis from 'ioredis';
import { env } from './env.js';
import logger from '../utils/logger.js';

// Redis is optional — if REDIS_URL is not set, skip and use a no-op client.
export const redis = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      lazyConnect: true,
      retryStrategy: () => null,
    })
  : null;

if (redis) {
  redis.on('connect', () => logger.info('Redis connected'));
  redis.on('error', (err) => logger.error({ err }, 'Redis error'));
}

export async function connectRedis() {
  if (!redis) {
    logger.warn('REDIS_URL not set — running without cache');
    return;
  }
  if (redis.status === 'ready') return;
  try {
    await redis.connect();
  } catch (err) {
    logger.warn({ err }, 'Redis unavailable, continuing without cache');
  }
}
