'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RuntimeMessages = require('./messages.js');
const C3Sites = require('../../sites/index.js');

const access = { x: { name: 'X', home: 'https://x.com/home', enabled: true, goalAllowed: false, remainingMs: 0, expiresAt: 0, readyAt: 0, requestExpiresAt: 0, sessionMinutes: 5 } };
const snapshot = { ok: true, date: '2026-10-11', day: {}, settings: { trackedSites: ['x'] }, access, websiteTimeEnabled: false };

function client(reply) { return RuntimeMessages.create({ async sendMessage() { return reply; } }); }
test('runtime replies require an object envelope with a literal success boolean', async () => {
  for (const reply of [undefined, null, true, [], 'ok', {}, { ok: 1 }, { ok: 'true' }, { ok: false }, { ok: true, enabled: 'true' }]) {
    await assert.rejects(client(reply).send({ type: 'website-time-setting' }, 'Website time stays off.'), { message: 'Website time stays off.' });
  }
  const reply = { ok: true, enabled: false };
  assert.equal(await client(reply).send({ type: 'website-time-setting' }, 'Failed.'), reply);
});
test('backend and runtime failures preserve useful error text and otherwise use the local fallback', async () => {
  await assert.rejects(client({ ok: false, error: 'Storage is full.' }).send({ type: 'snapshot' }, 'Could not load.'), { message: 'Storage is full.' });
  for (const error of ['', 12, {}, null]) await assert.rejects(client({ ok: false, error }).send({ type: 'snapshot' }, 'Could not load.'), { message: 'Could not load.' });
  const runtime = RuntimeMessages.create({ async sendMessage() { throw new Error('Extension context invalidated'); } });
  await assert.rejects(runtime.send({ type: 'snapshot' }, 'Could not load.'), { message: 'Extension context invalidated' });
  await assert.rejects(RuntimeMessages.create({ async sendMessage() { throw undefined; } }).send({ type: 'snapshot' }, 'Could not load.'), { message: 'Could not load.' });
});
test('access replies reject unusable budgets and flags, but need no undocumented optional fields', async () => {
  for (const type of ['access-status', 'access-begin', 'access-open', 'access-cancel', 'access-end', 'access-duration', 'access-goal-setting']) {
    const reply = { ok: true, access };
    assert.equal(await client(reply).send({ type }, 'Site stays blocked.'), reply);
    assert.deepEqual(await client({ ok: true, access: {} }).send({ type }, 'Failed.'), { ok: true, access: {} });
    for (const invalid of [null, [], {}, { ...access.x, enabled: 'false' }, { ...access.x, goalAllowed: 'true' }, { ...access.x, remainingMs: '60000' }, { ...access.x, remainingMs: Infinity }, { ...access.x, remainingMs: -1 }, { ...access.x, home: 'javascript:alert(1)' }]) {
      await assert.rejects(client({ ok: true, access: { x: invalid } }).send({ type }, 'Site stays blocked.'), { message: 'Site stays blocked.' });
      await assert.rejects(client({ ...snapshot, access: { x: invalid } }).send({ type: 'snapshot' }, 'Failed.'), { message: 'Failed.' });
    }
    await assert.rejects(client({ ok: true }).send({ type }, 'Site stays blocked.'), { message: 'Site stays blocked.' });
  }
});
test('access homes must be parseable credential-free HTTPS URLs for the matching vetted canonical site', async () => {
  for (const { id } of C3Sites.sites.filter(site => site.gated)) {
    const definition = C3Sites.get(id);
    const state = { ...access.x, name: definition.name, home: definition.access.home };
    const reply = { ok: true, access: { [id]: state } };
    assert.equal(await client(reply).send({ type: 'access-status' }, 'Site stays blocked.'), reply);
    const other = C3Sites.sites.find(site => site.gated && site.id !== id);
    const credentialURL = new URL(state.home); credentialURL.username = 'user'; credentialURL.password = 'secret';
    for (const home of ['https://[/', 'https://evil.test/', 'http://' + new URL(state.home).host + '/', credentialURL.href, C3Sites.get(other.id).access.home, state.home + '?redirect=https://evil.test/']) {
      await assert.rejects(client({ ok: true, access: { [id]: { ...state, home } } }).send({ type: 'access-status' }, 'Site stays blocked.'), { message: 'Site stays blocked.' });
    }
  }
});
test('history replies must support rendering and CSV export without requiring full stat rows', async () => {
  for (const kind of ['ratio', 'websites']) {
    const days = kind === 'ratio' ? { '2026-10-11': { retired: { posts: 1 } } } : { '2026-10-11': { 'example.com': 12 } };
    const reply = { ok: true, days };
    assert.equal(await client(reply).send({ type: 'history', kind }, 'History unavailable.'), reply);
    for (const invalid of [undefined, null, [], { '2026-10-11': null }, { '2026-10-11': [] }]) {
      await assert.rejects(client({ ok: true, days: invalid }).send({ type: 'history', kind }, 'History unavailable.'), { message: 'History unavailable.' });
    }
  }
  const reply = { ok: true, intentions: [{ site: 'retired', reason: 'Legacy intention', requestedAt: 1 }] };
  assert.equal(await client(reply).send({ type: 'access-history-list' }, 'Failed.'), reply);
  for (const intentions of [null, {}, [null], [{ reason: 'Missing site' }]]) await assert.rejects(client({ ok: true, intentions }).send({ type: 'access-history-list' }, 'Failed.'), { message: 'Failed.' });
  for (const type of ['access-history-setting', 'access-history-clear']) assert.deepEqual(await client({ ok: true }).send({ type }, 'Failed.'), { ok: true });
});
test('snapshot dates follow the shared real-calendar policy', async () => {
  for (const date of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-01', '2026-04-31', '2026-01-00', '2026-2-01']) {
    await assert.rejects(client({ ...snapshot, date }).send({ type: 'ingest' }, 'No usable data.'), { message: 'No usable data.' });
  }
  for (const date of ['2024-02-29', '2026-02-28']) {
    const reply = { ...snapshot, date };
    assert.equal(await client(reply).send({ type: 'snapshot' }, 'Failed.'), reply);
  }
});
test('snapshot and ingest acknowledgements are usable without optional delivery or animation metadata', async () => {
  for (const type of ['snapshot', 'ingest', 'tracking', 'clear-history']) {
    assert.equal(await client(snapshot).send({ type }, 'No usable data.'), snapshot);
    for (const patch of [{ day: null }, { day: [] }, { settings: null }, { settings: { trackedSites: 'x' } }, { access: null }, { access: [] }, { date: 12 }, { websiteTimeEnabled: 'false' }, { generation: {} }]) {
      await assert.rejects(client({ ...snapshot, ...patch }).send({ type }, 'No usable data.'), { message: 'No usable data.' });
    }
    await assert.rejects(client({ ok: true }).send({ type }, 'No usable data.'), { message: 'No usable data.' });
  }
});

test('scroll-friction saves require a complete snapshot with a persisted boolean preference', async () => {
  for (const settings of [{}, { scrollFrictionEnabled: 'true' }, { scrollFrictionEnabled: 1 }, { scrollFrictionEnabled: null }]) {
    await assert.rejects(client({ ...snapshot, settings }).send({ type: 'scroll-friction-setting' }, 'Not saved.'), { message: 'Not saved.' });
  }
  for (const enabled of [true, false]) {
    const reply = { ...snapshot, settings: { scrollFrictionEnabled: enabled } };
    assert.equal(await client(reply).send({ type: 'scroll-friction-setting' }, 'Not saved.'), reply);
  }
});
test('resistance acknowledgements require a validated persisted strength when the command supplies one', async () => {
  const command = { type: 'scroll-friction-setting', enabled: true, strength: 75 };
  for (const strength of [undefined, null, '75', 0, -5, 5, 25, 45, 99, 100, 77, 75.5]) {
    const reply = { ...snapshot, settings: { scrollFrictionEnabled: true, scrollFrictionStrength: strength } };
    await assert.rejects(client(reply).send(command, 'Not saved.'), { message: 'Not saved.' });
  }
  for (const strength of [50, 75, 95]) {
    const reply = { ...snapshot, settings: { scrollFrictionEnabled: true, scrollFrictionStrength: strength } };
    assert.equal(await client(reply).send({ ...command, strength }, 'Not saved.'), reply);
  }
});
test('storage refreshes distinguish access phases from countdown-only writes', () => {
  const running = { remainingMs: 60000, expiresAt: 100000, date: '2026-10-11', refilledAt: 40000 };
  const notification = (oldValue, newValue) => ({ _access: { oldValue, newValue } });
  assert.equal(RuntimeMessages.shouldRefresh(notification({ x: running }, { x: { ...running, remainingMs: 59000, expiresAt: 99999 } }), 'local'), false);
  assert.equal(RuntimeMessages.shouldRefresh(notification({ x: running }, { x: Object.fromEntries(Object.entries(running).reverse()) }), 'local'), false);
  for (const next of [
    {}, { x: { ...running, remainingMs: 0 } }, { x: { ...running, expiresAt: 0 } },
    { x: { ...running, date: '2026-10-12' } }, { x: { ...running, refilledAt: 50000 } },
    { x: { readyAt: 100000, requestExpiresAt: 700000 } }
  ]) assert.equal(RuntimeMessages.shouldRefresh(notification({ x: running }, next), 'local'), true);
  assert.equal(RuntimeMessages.shouldRefresh(notification({}, { x: running }), 'local'), true);
  assert.equal(RuntimeMessages.shouldRefresh(notification({ x: { ...running, expiresAt: 0 } }, { x: running }), 'local'), true);
  assert.equal(RuntimeMessages.shouldRefresh(notification({ x: { readyAt: 100000, requestExpiresAt: 700000 } }, {}), 'local'), true);
});

test('update coordination metadata does not trigger unrelated page refreshes', () => {
  for (const key of ['_pendingUpdate', '_updateRecovery']) {
    assert.equal(RuntimeMessages.shouldRefresh({ [key]: { newValue: true } }, 'local'), false);
  }
});

test('website-time buckets wait for polling without suppressing preferences, history resets, or creation activity', () => {
  const websites = { '_websiteTime:2026-10-11': { oldValue: { 'example.test': 1 }, newValue: { 'example.test': 2 } } };
  assert.equal(RuntimeMessages.shouldRefresh(websites, 'local'), false);
  assert.equal(RuntimeMessages.shouldRefresh({}, 'local'), false);
  for (const key of ['settings', '_historyGeneration', '_intentions', '_websiteTimeEnabled', '2026-10-11']) {
    const changes = { ...websites, [key]: { newValue: {} } };
    assert.equal(RuntimeMessages.shouldRefresh(changes, 'local'), true, key);
    assert.equal(RuntimeMessages.shouldRefresh(changes, 'session'), false, key);
    assert.equal(RuntimeMessages.shouldRefresh(changes, 'sync'), false, key);
  }
});
