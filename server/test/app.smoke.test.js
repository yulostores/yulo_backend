// Smoke coverage for the routes that need no datastore: the health probe, the public
// app-config payload the customer app boots from, the legal documents, and the 404 shape.
// A one-word path typo or a broken config assembly (audit C5, M8) fails this.

import { startTestServer } from '../test-utils/appHarness.mjs';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

let srv;
before(async () => {
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
});

test('GET /health → 200 ok', async () => {
  const { status, body } = await srv.get('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(body.timestamp, 'has a timestamp');
});

test('GET /api/app/config → the payload the customer app renders Settings from', async () => {
  const { status, body } = await srv.get('/api/app/config');
  assert.equal(status, 200);
  assert.equal(body.status, 'success');

  const config = body.data?.config;
  assert.ok(config, 'data.config is present');

  // Languages: shown in the picker, exactly one actually shippable today.
  assert.ok(Array.isArray(config.languages) && config.languages.length > 0);
  assert.equal(config.languages.filter((l) => l.available).length, 1);
  assert.ok(config.languages.some((l) => l.code === config.defaultLanguage));

  // Payments: the catalogue the checkout picker twins (see the contract test).
  assert.ok(Array.isArray(config.payments?.groups) && config.payments.groups.length > 0);
  assert.ok(Array.isArray(config.payments?.methods) && config.payments.methods.length > 0);
  for (const m of config.payments.methods) {
    assert.ok(['cod', 'online'].includes(m.wire), `method ${m.id} has a valid wire`);
  }

  // Legal summaries only — no section bodies in this payload.
  assert.ok(Array.isArray(config.legal) && config.legal.length > 0);
  assert.ok(config.legal.every((d) => !('sections' in d)), 'legal summaries carry no bodies');
});

test('GET /api/app/legal/:id → one document with sections, 404 for an unknown id', async () => {
  const ok = await srv.get('/api/app/legal/privacy');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data?.document?.id, 'privacy');
  assert.ok(Array.isArray(ok.body.data.document.sections) && ok.body.data.document.sections.length > 0);

  const missing = await srv.get('/api/app/legal/does-not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

test('unknown route → 404 with the standard error envelope', async () => {
  const { status, body } = await srv.get('/api/not-a-real-route');
  assert.equal(status, 404);
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'NOT_FOUND');
});
