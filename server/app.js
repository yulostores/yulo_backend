import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import logger from './utils/logger.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import appRoutes from './routes/app.routes.js';
import restaurantRoutes from './routes/restaurant.routes.js';
import cuisineRoutes from './routes/cuisine.routes.js';
import itemRoutes from './routes/item.routes.js';
import searchRoutes from './routes/search.routes.js';
import homeRoutes from './routes/home.routes.js';
import cartRoutes from './routes/cart.routes.js';
import checkoutRoutes from './routes/checkout.routes.js';
import orderRoutes from './routes/order.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import reviewRoutes from './routes/review.routes.js';
import supportRoutes from './routes/support.routes.js';
import ownerRouter from './routes/owner/index.js';
import staffRouter from './routes/staff/index.js';
import adminRouter from './routes/admin/index.js';
import partnerRouter from './routes/partner/index.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
// helmet's default CSP (script-src 'self', etc.) would silently block
// public/checkout.html from loading Razorpay's hosted checkout.js and talking to
// Razorpay's own domains — this page is the one place in the app that needs to load a
// third-party script, so those headers are rewritten here, scoped to just this path.
// A second helmet({ contentSecurityPolicy: false }) instance does NOT work for this —
// `false` just skips that middleware's own header write, it doesn't clear the value the
// blanket helmet() above already set — so this sets res headers directly instead,
// overwriting/removing them for requests matching this exact route only.
app.use('/checkout.html', (req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://checkout.razorpay.com",
      "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://lumberjackv2.razorpay.com",
      "frame-src https://api.razorpay.com https://checkout.razorpay.com",
      "img-src 'self' data: https://*.razorpay.com",
      "style-src 'self' 'unsafe-inline'",
    ].join('; ')
  );
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  next();
});
// ALLOWED_ORIGINS=* was previously passed straight through as `origin: ['*']` — the `cors`
// package does exact string matching against the array, so a real browser's Origin header
// (always a real URL, never the literal string "*") could never match; combined with
// `credentials: true`, a literal '*' isn't even spec-legal (browsers reject
// Access-Control-Allow-Origin: * alongside Access-Control-Allow-Credentials: true). This silently
// blocked every real browser client — never caught before because every prior test against this
// backend was curl or a raw socket.io-client script, neither of which enforces CORS at all.
// `origin: true` makes the `cors` package dynamically reflect whatever Origin the request
// actually sent (the correct way to say "any origin" while still allowing credentials); a real
// comma-separated allowlist (the production case) is unaffected, still exact-matched as before.
const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins, credentials: true }));

// Mounted BEFORE express.json(): Razorpay signs the exact raw request bytes, which
// express.json() below would already have parsed (and could re-serialize differently)
// by the time any route further down the stack saw them. express.raw() here — applied
// only to this one path, not globally — is what lets controllers/webhook.controller.js
// verify against the untouched body. As a side effect this also runs before
// cookieParser/pinoHttp/apiLimiter below; none of those matter for a signature-
// authenticated, cookie-less server-to-server call, and apiLimiter's per-IP customer
// assumption doesn't fit Razorpay's delivery pattern anyway.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(pinoHttp({ logger }));
// Session refresh is deliberately outside this budget — it carries its own,
// higher one (routes/auth.routes.js). Sharing the global one meant a burst of
// screen requests could 429 the refresh call, which the clients could not tell
// apart from an expired session, so they signed the user out on every reload.
app.use('/api', (req, res, next) =>
  req.path === '/auth/refresh' ? next() : apiLimiter(req, res, next)
);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/app', appRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/cuisines', cuisineRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/owner', ownerRouter);
app.use('/api/admin', adminRouter);
app.use('/api/staff', staffRouter);
app.use('/api/partner', partnerRouter);

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use(express.static('public'));

app.use((req, res) => res.status(404).json({
  status: 'error',
  code: 'NOT_FOUND',
  message: `Route ${req.method} ${req.originalUrl} not found`,
}));

app.use(errorHandler);

export { app };
