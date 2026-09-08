// Sentry bootstrap — imported first by index.js, before http/express are pulled in
// anywhere else, because Sentry's auto-instrumentation has to wrap those modules as
// they load.
//
// With no SENTRY_DSN set (local dev, CI, a staging box without monitoring) this is a
// complete no-op: Sentry.init is never called, setupExpressErrorHandler in app.js is
// skipped, and nothing else in the codebase knows Sentry exists. Set SENTRY_DSN in the
// platform dashboard to turn it on — no code change.
//
// Note: full performance auto-instrumentation under ESM wants `node --import
// ./instrument.js`; importing it first here still gives complete error capture
// (captureException + the Express error handler), which is what this is here for.

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || undefined,
    // Error monitoring is the goal; tracing stays off unless a rate is explicitly set.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
}

export const sentryEnabled = Boolean(dsn);
