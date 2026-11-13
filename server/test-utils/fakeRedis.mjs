// An in-memory stand-in for the slice of the ioredis API the OTP flow and the token denylist use
// (get / set with EX and NX / incr / expire / del / ttl). The test environment has no Redis
// (test-utils/testEnv.mjs removes REDIS_URL), so tests plug this in through the services' own
// seams — services/otp.service.js#__setOtpRedisForTests and
// services/auth.service.js#__setAuthRedisForTests. Expiry is real time, checked on read.
//
//   const redis = fakeRedis();
//   otp.__setOtpRedisForTests(redis); auth.__setAuthRedisForTests(redis);
//   ... redis.clear() between tests ...
//   otp.__setOtpRedisForTests(undefined); // back to the real client

export function fakeRedis() {
  const store = new Map(); // key → { value, expiresAt | null }

  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  return {
    status: 'ready',
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ...args) {
      if (args.includes('NX') && live(key)) return null;
      const ex = args.indexOf('EX');
      const expiresAt = ex >= 0 ? Date.now() + Number(args[ex + 1]) * 1000 : null;
      store.set(key, { value: String(value), expiresAt });
      return 'OK';
    },
    async incr(key) {
      const entry = live(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    async expire(key, seconds) {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + Number(seconds) * 1000;
      return 1;
    },
    async ttl(key) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - Date.now()) / 1000);
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys.flat()) if (live(key) && store.delete(key)) removed += 1;
      return removed;
    },
    /** Test helper: forget everything. */
    clear() {
      store.clear();
    },
    /** Test helper: the raw keys currently held. */
    keys() {
      return [...store.keys()].filter((k) => live(k));
    },
  };
}
