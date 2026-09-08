import 'dotenv/config';
// Must load before ./app.js (and before http below) so Sentry can instrument them.
// A complete no-op unless SENTRY_DSN is set — see instrument.js.
import './instrument.js';
import http from 'http';
import net from 'node:net';
import { app } from './app.js';
import { initSocket } from './socket.js';
import { connectDB } from './config/db.js';
import { connectRedis } from './config/redis.js';
import { env } from './config/env.js';
import logger from './utils/logger.js';

// Happy Eyeballs for every outbound socket this process opens.
//
// The container gets an IPv6 address it cannot actually route through, and
// `res.cloudinary.com` (behind Cloudflare) publishes AAAA records — so an outbound
// connection that picks the AAAA answer connects to nothing and simply waits. Node's
// `https` module resolves in OS order and lands on IPv4, which is why *uploads* to
// Cloudinary have always worked; `fetch` is undici, which takes the first address DNS
// returns, which is why *reading a document back* stalled until the gateway gave up at 60s
// and answered 504. Node only defaults this on from v20; package.json now pins `engines`
// to >=20, but this stays set explicitly as defence in depth: try both families in
// parallel and keep whichever connects.
if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(true);

const server = http.createServer(app);
initSocket(server);

await connectDB();
await connectRedis();

// Both RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET are .optional() in config/env.js on purpose
// (local dev without a gateway is a valid setup) — but that same optionality means a
// production deploy with them simply forgotten would silently keep serving the
// simulate-payment fallback (controllers/order.controller.js) with no other signal.
// A loud warning, not a hard crash — staging/demo environments may legitimately run
// without a gateway configured.
if (env.NODE_ENV === 'production') {
  const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].filter(
    (key) => !env[key]
  );
  if (missing.length) {
    logger.warn(
      { missing },
      'Razorpay is not fully configured in production — online payments will silently fall back to simulated payment'
    );
  }
}

server.listen(env.PORT, () => logger.info(`Server running on port ${env.PORT}`));

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
