import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

// CORS preflights carry no credentials and do no work — counting them would
// halve every real budget below.
const skipPreflight = (req) => req.method === 'OPTIONS';

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many login attempts' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// A single owner-dashboard load fans out to ~15-25 endpoints (and React's
// StrictMode doubles that in development), so the old 100/min budget was spent
// by the fourth page refresh — every screen then 429'd, POST /auth/refresh with
// it, and the portal signed the owner out. Keep a ceiling against abuse, but set
// it above what the app legitimately needs.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});

// Session refresh gets its own budget so a busy (or runaway) page can never cost
// the user their session: being rate limited out of /auth/refresh is
// indistinguishable, client-side, from having no session left. It is cheap —
// one cookie verify and one findById — and is only reachable with a valid
// httpOnly refresh cookie.
export const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { status: 'error', code: 'RATE_LIMITED', message: 'Too many refresh attempts' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipPreflight,
});
