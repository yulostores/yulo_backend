import 'dotenv/config';
// Must load before ./app.js (and before http below) so Sentry can instrument them.
// A complete no-op unless SENTRY_DSN is set — see instrument.js.
import './instrument.js';
import http from 'http';
import net from 'node:net';
import mongoose from 'mongoose';
import { app } from './app.js';
import { initSocket } from './socket.js';
import { connectDB } from './config/db.js';
import { connectRedis, redis } from './config/redis.js';
import { env } from './config/env.js';
import { startSettlementScheduler } from './jobs/settlementScheduler.js';
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
const io = initSocket(server);

await connectDB();
await connectRedis();

// Mongoose builds the models' indexes in the background once connected and logs nothing when
// a build fails — yet the unique ones are what keep money writes idempotent (one ledger row
// per order, one settlement per restaurant-week, one webhook processed once…). Say so loudly.
// Not awaited: a large collection's build must not hold up the server starting.
for (const model of Object.values(mongoose.models)) {
  model.init().catch((err) => {
    // A build cut short because the server is shutting down (a restart during the first boot
    // on a large or fresh database) didn't fail — it resumes on the next start. Don't send
    // anyone hunting for duplicates that aren't there.
    if (err?.name === 'MongoClientClosedError' || err?.name === 'MongoNotConnectedError' || mongoose.connection.readyState !== 1) {
      logger.warn({ model: model.modelName }, 'Index build interrupted by shutdown — it resumes on the next start');
      return;
    }
    logger.error(
      { err, model: model.modelName },
      'Index build failed — run scripts/checkIndexes.js and resolve the duplicates it reports'
    );
  });
}

// RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET are .optional() in config/env.js on purpose (local
// dev without a gateway is a valid setup). In production a missing key no longer falls back
// to simulated payment — online payment fails closed with 503 PAYMENT_GATEWAY_UNAVAILABLE
// (services/payment.service.js) — but that means customers can't pay online at all, so it
// is still worth a loud line at boot. A missing WEBHOOK_SECRET alone means payments only
// settle through the app's own verify call, never through Razorpay's server-to-server retry.
if (env.NODE_ENV === 'production') {
  const missing = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].filter(
    (key) => !env[key]
  );
  if (missing.length) {
    logger.warn(
      { missing },
      'Razorpay is not fully configured in production — online payments will be refused or will not settle from webhooks'
    );
  }
  if (env.ALLOW_PAYMENT_SIMULATION) {
    logger.warn('ALLOW_PAYMENT_SIMULATION is set in production — ignored; simulated payments stay disabled');
  }
}

server.listen(env.PORT, () => logger.info(`Server running on port ${env.PORT}`));

// Weekly restaurant settlements (Monday 03:00 IST) — see jobs/settlementScheduler.js.
const settlementScheduler = startSettlementScheduler();

// Graceful shutdown (a deploy sends SIGTERM, then SIGKILL after a grace period). server.close()
// alone never finishes while a Socket.IO client is connected — the instance used to hang until
// it was killed, possibly mid-way through a settlement run or a refund. Order: stop taking new
// scheduled work (letting a running tick finish), disconnect sockets and stop the HTTP server,
// then close the database and Redis. A hard timeout covers anything that still hangs.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  const force = setTimeout(() => {
    logger.warn('Graceful shutdown timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await settlementScheduler.stop();
    // Closes every socket and, with them, the HTTP server it is attached to.
    await new Promise((resolve) => io.close(() => resolve()));
    await mongoose.disconnect();
    if (redis && redis.status !== 'end') await redis.quit().catch(() => {});
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
