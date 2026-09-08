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

/**
 * Boot the Express app on an ephemeral port and hand back a `fetch`-style client.
 * `await using` (or an explicit `await server.close()`) tears it down.
 */
export async function startTestServer() {
  const { app } = await import('../app.js');

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    /** GET `path`, parse JSON, return { status, body }. */
    async get(path) {
      const res = await fetch(base + path);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
