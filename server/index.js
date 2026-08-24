import 'dotenv/config';
import http from 'http';
import { app } from './app.js';
import { initSocket } from './socket.js';
import { connectDB } from './config/db.js';
import { connectRedis } from './config/redis.js';
import { env } from './config/env.js';
import logger from './utils/logger.js';

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
