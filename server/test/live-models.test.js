// Live customer activity — A1: the feature switch and per-restaurant access, the shared clock, the
// CustomerSession / ActivityEvent models and their indexes, the `shareActivity` preference with
// opt-out, the one-time notice acknowledgement, the app-config signal and the local-only
// shortened timings. In-memory MongoDB.

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const live = await import('../config/liveActivity.config.js');
const clock = await import('../utils/clock.js');
const { default: CustomerSession, sessionStatusFields, sessionExpiresAt } = await import(
  '../models/CustomerSession.js'
);
const { default: ActivityEvent, eventExpiresAt } = await import('../models/ActivityEvent.js');
const { default: User } = await import('../models/User.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { default: AdminActivityLog } = await import('../models/AdminActivityLog.js');
const access = await import('../services/liveActivityAccess.service.js');
const {
  ObjectId,
  authHeader: bearer,
  makeCustomer,
  makeGuest,
  makeLegacyCustomer,
  makeRestaurant,
  makeSession: session,
} = await import('../test-utils/liveFixtures.mjs');
const DAY = 24 * 60 * 60 * 1000;
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

let mongo;
let srv;

before(async () => {
  mongo = await startMemoryMongo();
  await Promise.all([CustomerSession.init(), ActivityEvent.init(), User.init()]);
  srv = await startTestServer();
});
after(async () => {
  live.__setLiveActivityForTests(null);
  clock.__setClockForTests(null);
  await srv?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await mongo.clear();
  // Off explicitly — not "whatever the shell's LIVE_ACTIVITY_ENABLED says" — so the suite gives
  // the same result with the variable set either way (the default itself is checked below).
  live.__setLiveActivityForTests({ enabled: false, restaurantIds: '' });
  clock.__setClockForTests(null);
});

// ─── Models and indexes ────────────────────────────────────────────────────

describe('CustomerSession / ActivityEvent models', () => {
  test('one open session per restaurant + customer; closed ones never block a new one', async () => {
    const restaurantId = new ObjectId();
    const userId = new ObjectId();
    await session({ restaurantId, userId });

    await assert.rejects(() => session({ restaurantId, userId }), (err) => err.code === 11000);

    const closed = await session({ restaurantId, userId: new ObjectId(), status: 'ended' });
    assert.equal(closed.isOpen, false, 'isOpen follows the status on create');
    await session({ restaurantId, userId: closed.userId }); // an ended session doesn't block

    // Two different customers each hold one open session at the same restaurant.
    await session({ restaurantId, userId: new ObjectId() });
    assert.equal(await CustomerSession.countDocuments({ restaurantId, isOpen: true }), 3);
  });

  test('isOpen tracks status on save, and sessionStatusFields gives both for updates', async () => {
    const s = await session();
    assert.equal(s.isOpen, true);
    s.status = 'abandoned';
    await s.save();
    assert.equal(s.isOpen, false);

    assert.deepEqual(sessionStatusFields('idle'), { status: 'idle', isOpen: true });
    assert.deepEqual(sessionStatusFields('converted'), { status: 'converted', isOpen: false });
  });

  test('expiry: sessions 90 days after last activity, events 30 days after they happen', async () => {
    const last = new Date('2026-10-27T10:00:00Z');
    const s = await session({ lastActivityAt: last });
    assert.equal(s.expiresAt.getTime(), last.getTime() + 90 * DAY);
    assert.equal(sessionExpiresAt(last).getTime(), last.getTime() + 90 * DAY);

    s.lastActivityAt = new Date(last.getTime() + DAY);
    await s.save();
    assert.equal(s.expiresAt.getTime(), last.getTime() + 91 * DAY, 'moves with lastActivityAt');

    const at = new Date('2026-10-27T11:00:00Z');
    const e = await ActivityEvent.create({
      sessionId: s._id,
      restaurantId: s.restaurantId,
      userId: s.userId,
      type: 'restaurant_viewed',
      label: 'Viewed menu',
      at,
    });
    assert.equal(e.expiresAt.getTime(), at.getTime() + 30 * DAY);
    assert.equal(eventExpiresAt(at).getTime(), at.getTime() + 30 * DAY);
  });

  test('both collections have a TTL index on expiresAt with expireAfterSeconds 0', async () => {
    for (const Model of [CustomerSession, ActivityEvent]) {
      const ttl = (await Model.collection.indexes()).find((ix) => ix.key.expiresAt === 1);
      assert.ok(ttl, `${Model.modelName} has an expiresAt index`);
      assert.equal(ttl.expireAfterSeconds, 0);
    }
  });

  test('ActivityEvent refuses unknown event types and free-form fields', async () => {
    const base = {
      sessionId: new ObjectId(),
      restaurantId: new ObjectId(),
      userId: new ObjectId(),
      label: 'x',
      at: new Date(),
    };
    await assert.rejects(() => ActivityEvent.create({ ...base, type: 'made_up' }));
    await assert.rejects(() => ActivityEvent.create({ ...base, type: 'item_viewed', phone: '9876543210' }));
  });
});

// ─── Preferences: shareActivity + notice ───────────────────────────────────

describe('preferences: shareActivity and the notice', () => {
  test('a user with no stored value reads as sharing on (flag on); flag off leaves GET as before', async () => {
    // A row written before the field existed — inserted raw so no Mongoose default fills it in.
    const user = await makeLegacyCustomer({ vegModeEnabled: true, preferredLanguage: 'en' });

    const off = await srv.get('/api/users/me/preferences', bearer(user));
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.data.preferences, { vegModeEnabled: true, preferredLanguage: 'en' });

    live.__setLiveActivityForTests({ enabled: true });
    const on = await srv.get('/api/users/me/preferences', bearer(user));
    assert.equal(on.body.data.preferences.shareActivity, true);
    assert.equal(on.body.data.preferences.activityNoticeAt, null);
    assert.equal(on.body.data.preferences.vegModeEnabled, true);
  });

  test('shareActivity must be a real boolean', async () => {
    const user = await makeCustomer();
    for (const bad of ['false', 1, 0, null]) {
      const res = await srv.request('PATCH', '/api/users/me/preferences', {
        body: { shareActivity: bad },
        headers: bearer(user),
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} refused`);
    }
    const ok = await srv.request('PATCH', '/api/users/me/preferences', {
      body: { shareActivity: false },
      headers: bearer(user),
    });
    assert.equal(ok.status, 200);
    assert.equal((await User.findById(user._id)).preferences.shareActivity, false);
  });

  test('opting out (flag on) ends open sessions and hides every session of that customer only', async () => {
    live.__setLiveActivityForTests({ enabled: true });
    const at = new Date('2026-10-27T12:00:00Z');
    clock.__setClockForTests(() => at);
    const user = await makeCustomer();
    const open = await session({ userId: user._id });
    const closed = await session({ userId: user._id, status: 'abandoned' });
    const someoneElse = await session();

    const res = await srv.request('PATCH', '/api/users/me/preferences', {
      body: { shareActivity: false },
      headers: bearer(user),
    });
    assert.equal(res.status, 200);

    const o = await CustomerSession.findById(open._id).lean();
    assert.equal(o.status, 'ended');
    assert.equal(o.isOpen, false);
    assert.equal(o.hiddenAt.getTime(), at.getTime());

    const c = await CustomerSession.findById(closed._id).lean();
    assert.equal(c.status, 'abandoned', 'a closed session keeps its status');
    assert.equal(c.hiddenAt.getTime(), at.getTime());

    const other = await CustomerSession.findById(someoneElse._id).lean();
    assert.equal(other.hiddenAt, null);
    assert.equal(other.isOpen, true);
  });

  test('opting out with the flag off saves the setting and touches no session', async () => {
    const user = await makeCustomer();
    const open = await session({ userId: user._id });

    await srv.request('PATCH', '/api/users/me/preferences', {
      body: { shareActivity: false },
      headers: bearer(user),
    });

    assert.equal((await User.findById(user._id)).preferences.shareActivity, false);
    const o = await CustomerSession.findById(open._id).lean();
    assert.equal(o.isOpen, true);
    assert.equal(o.hiddenAt, null);
  });

  test('the notice is recorded once and never moved; other preference updates keep both fields', async () => {
    live.__setLiveActivityForTests({ enabled: true });
    const user = await makeCustomer();
    const first = new Date('2026-10-27T09:00:00Z');
    clock.__setClockForTests(() => first);

    await srv.request('PATCH', '/api/users/me/preferences', {
      body: { activityNoticeAcknowledged: true, shareActivity: false },
      headers: bearer(user),
    });
    clock.__setClockForTests(() => new Date('2026-10-28T09:00:00Z'));
    await srv.request('PATCH', '/api/users/me/preferences', {
      body: { activityNoticeAcknowledged: true },
      headers: bearer(user),
    });
    await srv.request('PATCH', '/api/users/me/preferences', {
      body: { vegModeEnabled: true },
      headers: bearer(user),
    });

    const prefs = (await User.findById(user._id).lean()).preferences;
    assert.equal(prefs.activityNoticeAt.getTime(), first.getTime());
    assert.equal(prefs.shareActivity, false, 'an unrelated update does not reset it');
    assert.equal(prefs.vegModeEnabled, true);

    const refused = await srv.request('PATCH', '/api/users/me/preferences', {
      body: { activityNoticeAcknowledged: false },
      headers: bearer(user),
    });
    assert.equal(refused.status, 400, 'only `true` is accepted');
  });

  test('guests can update these preferences, as they can every preference today', async () => {
    const guest = await makeGuest();
    const res = await srv.request('PATCH', '/api/users/me/preferences', {
      body: { shareActivity: false },
      headers: bearer(guest),
    });
    assert.equal(res.status, 200);
  });
});

// ─── Switch, per-restaurant access, clock, app config, timings ────────────────────────

describe('switch, per-restaurant access, clock and timings', () => {
  test('the feature is off by default', () => {
    // A fresh process with the variable unset, whatever this shell has exported.
    const env = { ...process.env, LOG_LEVEL: 'silent' };
    delete env.LIVE_ACTIVITY_ENABLED;
    const probe = spawnSync(
      process.execPath,
      [
        '--import',
        './test-utils/testEnv.mjs',
        '--input-type=module',
        '-e',
        "const l = await import('./config/liveActivity.config.js'); console.log(JSON.stringify([l.isLiveActivityEnabled(), l.isLiveActivityEnabledFor('64b000000000000000000001')]))",
      ],
      { cwd: SERVER_DIR, env, encoding: 'utf8' }
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim().split('\n').pop()), [false, false]);
  });

  test('per-restaurant access: on only with the switch on AND the restaurant turned on', () => {
    const a = new ObjectId().toString();
    const b = new ObjectId().toString();

    live.__setLiveActivityForTests({ enabled: true, perRestaurant: true });
    live.setLiveActivityRestaurants([]);
    assert.equal(live.isLiveActivityEnabledFor(a), false, 'no restaurant is on until an admin turns it on');

    live.setLiveActivityRestaurants([a.toUpperCase()]);
    assert.equal(live.isLiveActivityEnabledFor(a), true, 'turned on (case ignored)');
    assert.equal(live.isLiveActivityEnabledFor(new ObjectId(a)), true, 'ObjectId input works too');
    assert.equal(live.isLiveActivityEnabledFor(b), false, 'not turned on');
    assert.equal(live.isLiveActivityEnabledFor(null), false);

    live.markLiveActivityRestaurant(b, true);
    live.markLiveActivityRestaurant(a, false);
    assert.deepEqual([live.isLiveActivityEnabledFor(a), live.isLiveActivityEnabledFor(b)], [false, true]);

    live.__setLiveActivityForTests({ enabled: false, perRestaurant: true });
    assert.equal(live.isLiveActivityEnabledFor(b), false, 'the switch beats the restaurant setting');

    const parsed = live.parseRestaurantAllowList(`${a},not-an-id,,${b}`);
    assert.deepEqual([...parsed.ids].sort(), [a, b].sort());
    assert.deepEqual(parsed.invalid, ['not-an-id']);
  });

  test('a super admin turns it on and off for a store: saved, audit-logged, applied at once', async () => {
    live.__setLiveActivityForTests({ enabled: true, perRestaurant: true });
    live.setLiveActivityRestaurants([]);
    const { restaurant, owner } = await makeRestaurant();
    const admin = await User.create({ name: 'Admin', email: 'admin@test.local', role: 'admin' });
    const dashboard = () => srv.request('GET', `/api/owner/${restaurant._id}/live/sessions`, { headers: bearer(owner) });
    const toggle = (body, who = admin, id = restaurant._id) =>
      srv.request('PATCH', `/api/admin/stores/${id}/live-activity`, { body, headers: bearer(who) });
    const storeView = async () => (await srv.request('GET', `/api/admin/stores/${restaurant._id}`, { headers: bearer(admin) })).body.data;

    assert.equal((await dashboard()).status, 404, 'off until turned on');
    assert.equal((await storeView()).store.liveActivityEnabled, false);
    assert.deepEqual((await storeView()).liveActivity, { serverEnabled: true });

    const on = await toggle({ enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.data.liveActivity, { enabled: true, serverEnabled: true });
    assert.equal((await dashboard()).status, 200, 'applied on this instance straight away');
    assert.equal((await storeView()).store.liveActivityEnabled, true);
    assert.equal((await Restaurant.findById(restaurant._id).select('+liveActivityEnabled').lean()).liveActivityEnabled, true);

    // Another instance (an empty set here) picks it up on its next read.
    live.setLiveActivityRestaurants([]);
    await access.loadLiveActivityRestaurants();
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), true);

    // Turning it on again changes nothing and logs nothing new.
    assert.equal((await toggle({ enabled: true })).status, 200);
    const off = await toggle({ enabled: false });
    assert.deepEqual(off.body.data.liveActivity, { enabled: false, serverEnabled: true });
    assert.equal((await dashboard()).status, 404);
    await access.loadLiveActivityRestaurants();
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), false);

    const logs = await AdminActivityLog.find({ targetId: restaurant._id }).sort({ _id: 1 }).lean();
    assert.deepEqual(logs.map((l) => l.action), ['STORE_LIVE_ACTIVITY_ENABLED', 'STORE_LIVE_ACTIVITY_DISABLED']);
    assert.ok(logs.every((l) => String(l.adminId) === String(admin._id)));

    // Refused: a non-boolean, an extra field, an owner, an unknown store.
    assert.equal((await toggle({ enabled: 'yes' })).status, 400);
    assert.equal((await toggle({ enabled: true, ownerId: String(owner._id) })).status, 400);
    assert.equal((await toggle({ enabled: true }, owner)).status, 403);
    assert.equal((await toggle({ enabled: true }, admin, new ObjectId())).status, 404);
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), false);
  });

  test('the setting never appears in existing restaurant responses, and owners cannot set it', async () => {
    live.__setLiveActivityForTests({ enabled: true, perRestaurant: true });
    const { restaurant, owner } = await makeRestaurant();
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { liveActivityEnabled: true } });

    const responses = [
      await srv.request('GET', `/api/restaurants/${restaurant._id}`),
      await srv.request('GET', `/api/owner/${restaurant._id}/restaurant`, { headers: bearer(owner) }),
      await srv.request('GET', '/api/owner/restaurants', { headers: bearer(owner) }),
    ];
    for (const res of responses) {
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(res.body).includes('liveActivityEnabled'), 'not in the response');
    }

    await Restaurant.updateOne({ _id: restaurant._id }, { $unset: { liveActivityEnabled: 1 } });
    const patched = await srv.request('PATCH', `/api/owner/${restaurant._id}/restaurant`, {
      body: { description: 'New', liveActivityEnabled: true },
      headers: bearer(owner),
    });
    assert.equal(patched.status, 200);
    assert.equal((await Restaurant.findById(restaurant._id).select('+liveActivityEnabled').lean()).liveActivityEnabled, undefined);
  });

  test('with the server switch off the store choice is kept but has no effect, and nothing is read', async () => {
    live.__setLiveActivityForTests({ enabled: false, perRestaurant: true });
    live.setLiveActivityRestaurants([]);
    const { restaurant } = await makeRestaurant();
    const admin = await User.create({ name: 'Admin', email: 'admin2@test.local', role: 'admin' });
    const res = await srv.request('PATCH', `/api/admin/stores/${restaurant._id}/live-activity`, {
      body: { enabled: true },
      headers: bearer(admin),
    });
    assert.deepEqual(res.body.data.liveActivity, { enabled: true, serverEnabled: false });
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), false);

    live.setLiveActivityRestaurants([]);
    await access.loadLiveActivityRestaurants();
    live.__setLiveActivityForTests({ enabled: true, perRestaurant: true });
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), false, 'the switch-off load read nothing');
    await access.loadLiveActivityRestaurants();
    assert.equal(live.isLiveActivityEnabledFor(restaurant._id), true, 'and it applies once the switch is on');
  });

  test('the clock can be moved for tests and restored', () => {
    const fixed = new Date('2030-01-01T00:00:00Z');
    clock.__setClockForTests(() => fixed);
    assert.equal(clock.now().getTime(), fixed.getTime());
    clock.__setClockForTests(() => fixed.getTime() + 1000);
    assert.equal(clock.now().getTime(), fixed.getTime() + 1000, 'timestamps work too');
    clock.__setClockForTests(null);
    assert.ok(Math.abs(clock.now().getTime() - Date.now()) < 1000);
  });

  test('app config carries liveActivity only while the feature is on', async () => {
    const off = await srv.get('/api/app/config');
    assert.equal(off.status, 200);
    assert.equal('liveActivity' in off.body.data.config, false);
    assert.deepEqual(Object.keys(off.body.data.config), [
      'languages',
      'defaultLanguage',
      'payments',
      'tabBar',
      'about',
      'legal',
    ]);

    live.__setLiveActivityForTests({ enabled: true });
    const on = await srv.get('/api/app/config');
    assert.deepEqual(on.body.data.config.liveActivity, { enabled: true });
    const { liveActivity, ...rest } = on.body.data.config;
    assert.deepEqual(rest, off.body.data.config, 'nothing else changes');
  });

  test('test timings are shorter, and refused in production', () => {
    const normal = live.resolveSessionTimings();
    const fast = live.resolveSessionTimings({ testTimings: true, nodeEnv: 'development' });
    assert.deepEqual(normal, { idleAfterMs: 300_000, closeAfterMs: 1_800_000, checkoutLeftAfterMs: 600_000 });
    assert.ok(fast.idleAfterMs < normal.idleAfterMs);
    assert.ok(fast.closeAfterMs < normal.closeAfterMs);
    assert.ok(fast.checkoutLeftAfterMs < normal.checkoutLeftAfterMs);
    assert.throws(() => live.resolveSessionTimings({ testTimings: true, nodeEnv: 'production' }));
    assert.deepEqual(live.SESSION_TIMINGS, normal, 'tests run with the normal timings');
  });

  test('the server refuses to start in production with LIVE_ACTIVITY_TEST_TIMINGS', () => {
    const prodEnv = {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: fileURLToPath(new URL('../test-utils/empty.env', import.meta.url)),
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://127.0.0.1:1/never-connected',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      JWT_STAFF_SECRET: 'c'.repeat(48),
      JWT_PARTNER_SECRET: 'd'.repeat(48),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      LOG_LEVEL: 'silent',
    };
    const load = (extra) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config/env.js')"], {
        cwd: SERVER_DIR,
        env: { ...prodEnv, ...extra },
        encoding: 'utf8',
      });

    const ok = load({});
    assert.equal(ok.status, 0, ok.stderr);

    const refused = load({ LIVE_ACTIVITY_TEST_TIMINGS: 'true' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /LIVE_ACTIVITY_TEST_TIMINGS/);
  });
});
