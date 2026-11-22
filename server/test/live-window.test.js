// Visitors Analysis shows the last 30 minutes only: sessions last active earlier, and events
// older than that, are left out. In-memory MongoDB.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { makeSession } = await import('../test-utils/liveFixtures.mjs');
const { default: ActivityEvent } = await import('../models/ActivityEvent.js');
const { listSessions, listSessionEvents, LIVE_WINDOW_MINUTES } = await import('../services/personalOffer.service.js');

let mongo;
before(async () => {
  mongo = await startMemoryMongo();
});
after(async () => {
  await mongo?.stop();
});

test('only sessions and events from the last 30 minutes', async () => {
  assert.equal(LIVE_WINDOW_MINUTES, 30);
  const restaurantId = new mongoose.Types.ObjectId();
  const now = new Date();
  const minsAgo = (m) => new Date(now.getTime() - m * 60_000);

  const recent = await makeSession({ restaurantId, lastActivityAt: minsAgo(10), status: 'active', isOpen: true });
  await makeSession({ restaurantId, lastActivityAt: minsAgo(45), status: 'idle', displayName: 'Old' });

  const { sessions } = await listSessions(restaurantId, {}, now);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].displayName ?? sessions[0].name, 'Aarav');

  const base = { sessionId: recent._id, restaurantId, userId: recent.userId };
  await ActivityEvent.collection.insertMany([
    { ...base, type: 'menu_viewed', at: minsAgo(5) },
    { ...base, type: 'menu_viewed', at: minsAgo(50) },
  ]);
  const { events } = await listSessionEvents(restaurantId, recent._id, {}, now);
  assert.equal(events.length, 1);
});
