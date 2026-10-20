// Test harness — NOT under test/ on purpose, so `node --test` doesn't run it as a file.
//
// Import this before anything that reaches config/env.js. It fills in the env vars that
// schema (config/env.js) demands at import time — valid shapes, obvious throwaway values —
// so `import('../app.js')` succeeds without a real .env. The smoke suite only exercises
// routes that touch neither MongoDB nor Redis (index.js is what connects those; app.js
// does not), so nothing here needs a live datastore.

function setDefault(key, value) {
  if (!process.env[key]) process.env[key] = value;
}

const THROWAWAY_SECRET = 'test-only-not-a-real-secret-000000000000';

setDefault('NODE_ENV', 'test');
setDefault('MONGODB_URI', 'mongodb://127.0.0.1:27017/yulo_test');
setDefault('JWT_ACCESS_SECRET', THROWAWAY_SECRET);
setDefault('JWT_REFRESH_SECRET', THROWAWAY_SECRET);
setDefault('JWT_STAFF_SECRET', THROWAWAY_SECRET);
setDefault('JWT_PARTNER_SECRET', THROWAWAY_SECRET);

const parse = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Boot the Express app on an ephemeral port and hand back a `fetch`-style client.
 * `await using` (or an explicit `await server.close()`) tears it down.
 *
 * `withSocket: true` also attaches Socket.IO (no background sweeps) — needed by any route
 * that notifies over sockets, e.g. placing an order or recording a payment.
 */
export async function startTestServer({ withSocket = false } = {}) {
  const { app } = await import('../app.js');

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  let io = null;
  if (withSocket) {
    const { initSocket } = await import('../socket.js');
    io = initSocket(server, { backgroundJobs: false });
  }

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    /** GET `path`, parse JSON, return { status, body }. */
    async get(path, headers = {}) {
      const res = await fetch(base + path, { headers });
      return { status: res.status, body: await parse(res), headers: res.headers };
    },
    /**
     * Any method. `body` is JSON-encoded unless `raw` (a string/Buffer sent as-is with
     * content-type application/json — what a webhook needs for its signature).
     */
    async request(method, path, { body, raw, headers = {} } = {}) {
      const init = { method, headers: { ...headers } };
      if (raw !== undefined) {
        init.body = raw;
        init.headers['content-type'] = 'application/json';
      } else if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
      const res = await fetch(base + path, init);
      return { status: res.status, body: await parse(res), headers: res.headers };
    },
    async close() {
      if (io) await new Promise((resolve) => io.close(() => resolve()));
      else await new Promise((resolve) => server.close(resolve));
    },
  };
}
