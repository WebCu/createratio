'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const { worker, activeWorker, unlock, gate, intent, popupSender } = require('../tests/background-harness.js');
const { tracker } = require('../tests/content-harness.js');
test('initializes Chromium and Firefox backgrounds with their available storage APIs', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = activeWorker({}, browser); w.install();
    assert.equal((await w.send({ type: 'snapshot' })).ok, true);
    assert.deepEqual(w.accessLevels, browser === 'chrome' ? ['TRUSTED_CONTEXTS'] : []);
    assert.equal(w.alarms['daily-badge'].periodInMinutes, 1);
    assert.equal((await w.send(packet('first'))).ok, true);
    assert.equal(w.data[C.localDate()].x.consumeSec, 5);
  }
});
function packet(id, site = 'x') { return { type: 'ingest', id, site, segments: [{ date: C.localDate(), mode: 'consume', sec: 5 }], actions: [] }; }
test('serialized writes from concurrent tabs preserve all time and quote counts', async () => {
  const w = activeWorker(); const a = packet('a'); a.actions = [{ date: C.localDate(), action: 'quotes' }];
  const b = packet('b', 'linkedin'); b.actions = [{ date: C.localDate(), action: 'comments' }];
  const results = await Promise.all([w.send(a), w.send(b, { id: 'test-extension', tab: { id: 2 }, frameId: 0, url: 'https://www.linkedin.com/feed/' })]);
  assert.ok(results.every(r => r.ok));
  assert.equal(w.data[C.localDate()].x.consumeSec, 5); assert.equal(w.data[C.localDate()].linkedin.consumeSec, 5);
  assert.equal(w.data[C.localDate()].x.posts, 1); assert.equal(w.data[C.localDate()].x.quotes, 1);
  assert.equal(C.score(C.aggregate(w.data[C.localDate()])), 24); assert.equal(w.badge.color, '#16804a');
});
test('retrying a packet after service-worker restart does not double-count', async () => {
  const first = activeWorker(); await first.send(packet('same-id'));
  const restarted = worker(first.data); const response = await restarted.send(packet('same-id'));
  assert.equal(response.ok, true); assert.equal(first.data[C.localDate()].x.consumeSec, 5);
});
test('midnight-separated segments retain their original local date buckets', async () => {
  const w = worker({ _access: { x: { remainingMs: 300000 } } }, 'chrome', new Date(2026, 9, 12, 0, 0, 5).getTime()), p = packet('midnight');
  p.segments = [{ date: '2026-10-11', mode: 'create', sec: 2 }, { date: '2026-10-12', mode: 'create', sec: 3 }];
  assert.equal((await w.send(p)).ok, true); assert.equal(w.data['2026-10-11'].x.createSec, 2); assert.equal(w.data['2026-10-12'].x.createSec, 3);
});
test('extension preferences are validated and content scripts cannot change them', async () => {
  const w = worker(); const settings = { type: 'access-duration', minutes: 10 };
  assert.equal((await w.send(settings)).ok, false);
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const preferences = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', tab: { id: 3 }, frameId: 0 };
  assert.equal((await w.send({ ...settings, minutes: 0 }, preferences)).ok, false);
  assert.equal((await w.send(settings, preferences)).ok, true);
  assert.equal((await w.send(settings, popup)).ok, true);
  assert.equal((await w.send(settings, { ...popup, tab: { id: 3 }, frameId: 0 })).ok, true, 'popup opened in a tab can save settings');
  for (const sender of [{ id: 'test-extension' }, { ...popup, frameId: 1 }, { ...preferences, frameId: 1 }, gate('x')]) {
    assert.equal((await w.send(settings, sender)).ok, false, 'only top-level preference pages can save settings');
  }
  assert.equal(w.data.settings.accessMinutes, 10);
});
test('rejects unsupported senders and malformed packets without writing totals', async () => {
  const w = worker();
  const invalid = packet('bad'); invalid.segments[0].date = '2026-02-30';
  assert.equal((await w.send(invalid)).ok, false);
  assert.equal((await w.send(packet('wrong-site', 'linkedin'))).ok, false);
  assert.equal((await w.send(packet('subframe'), { id: 'test-extension', tab: { id: 1 }, frameId: 1, url: 'https://x.com/home' })).ok, false);
  assert.equal(Object.keys(w.data).length, 0);
});

test('website opt-in requires permissions and a trusted popup, including popup opened in a tab', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser), message = { type: 'website-time-setting', enabled: true };
    const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
    assert.equal((await w.send(message, popup)).ok, false, 'permission is required');
    w.grantWebsitePermissions();
    assert.equal((await w.send(message)).ok, false, 'content scripts cannot opt in');
    assert.equal((await w.send(message, { ...popup, frameId: 1 })).ok, false, 'subframes cannot opt in');
    assert.equal((await w.send(message, { ...popup, url: 'https://evil.test/popup.html' })).ok, false);
    assert.equal((await w.send(message, { ...popup, tab: { id: 1 }, frameId: 0 })).ok, true);
    assert.equal((await w.send({ type: 'snapshot' }, popup)).websiteTimeEnabled, true);
    assert.equal(w.data._websiteTimeEnabled, true);
    assert.equal((await w.send({ ...message, enabled: false }, popup)).ok, true);
    assert.equal((await w.send({ type: 'snapshot' }, popup)).websiteTimeEnabled, false);
    assert.equal((await w.send(message, popup)).ok, true, 'normal toolbar popup can also opt in');
  }
});

test('shared access lifecycle uses a third module’s home, aliases, session rules and cleanup IDs', async () => {
  const catalog = require('../../sites/index.js');
  const domains = ['example.test', 'alias.test'];
  const access = {
    domains, home: 'https://example.test/write', redirectRuleId: 4, ruleIds: [201, 202],
    unrestrictedRules: [
      { id: 201, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, resourceTypes: ['main_frame'] } },
      { id: 202, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['main_frame'] } }
    ],
    sessionRules: [{ id: 201, priority: 2, action: { type: 'allow' }, condition: { requestDomains: domains, excludedResourceTypes: ['sub_frame'] } }]
  };
  const plugin = { id: 'example', name: 'Example', hosts: ['example.test'], actions: ['posts'], access, classifyPage() { return 'neutral'; }, create() { return { mode() { return 'neutral'; }, action() { return null; } }; } };
  function hostname(raw) { try { return new URL(raw).hostname; } catch (_) { return ''; } }
  const integrations = {
    ...catalog, sites: [...catalog.sites, { ...plugin, gated: true, defaultEnabled: false }],
    get: id => id === plugin.id ? plugin : catalog.get(id),
    forURL: raw => hostname(raw) === 'example.test' ? plugin : catalog.forURL(raw),
    forAccessURL: raw => access.domains.some(domain => hostname(raw) === domain || hostname(raw).endsWith('.' + domain)) ? plugin : catalog.forAccessURL(raw)
  };
  for (const browser of ['chrome', 'browser']) {
    const w = worker({ settings: { trackedSites: ['x', 'linkedin', 'example'] } }, browser, Date.now(), { integrations });
    let result = await w.send({ type: 'access-status' });
    assert.equal(result.access.example.name, 'Example'); assert.equal(result.access.example.home, access.home);
    assert.equal(result.access.example.remainingMs, 0);
    await unlock(w, 'example');
    assert.deepEqual(w.rules, access.sessionRules);
    w.tabs.push({ id: 1, url: 'http://mobile.alias.test/read' }, { id: 2, url: 'https://example.test.evil.test/' });
    result = await w.send({ type: 'access-end', site: 'example' }, gate('example'));
    assert.equal(result.ok, true); assert.equal(result.access.example.remainingMs, 0); assert.deepEqual(w.rules, []);
    assert.equal(w.tabs[0].url, gate('example').url); assert.equal(w.tabs[1].url, 'https://example.test.evil.test/');
    result = await w.send(tracking('example', false), popupSender);
    assert.equal(result.ok, true); assert.equal(result.access.example.enabled, false);
    assert.deepEqual(w.rules, access.unrestrictedRules);
  }
});

test('Limit & track Off removes gates and measurement, preserves history and saved time', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({ settings: { accessMinutes: 12, siteOverrides: { x: { accessMinutes: 2 } } }, [C.localDate()]: { x: { consumeSec: 60 } } }, browser);
    await unlock(w); w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
    const result = await w.send(tracking('x', false), popupSender);
    assert.equal(result.ok, true); assert.equal(result.access.x.enabled, false); assert.equal(result.access.x.remainingMs, 0);
    assert.equal(w.data._access.x, undefined); assert.equal(w.alarms['access-x'], undefined);
    assert.deepEqual(w.rules, [
      { id: 101, priority: 2, action: { type: 'allow' }, condition: { requestDomains: ['x.com', 'twitter.com'], resourceTypes: ['main_frame'] } },
      { id: 104, priority: 2, action: { type: 'allow' }, condition: { requestDomains: ['x.com', 'twitter.com'], excludedResourceTypes: ['main_frame'] } }
    ]);
    assert.equal(w.data.settings.siteOverrides.x.accessMinutes, 2);
    await w.send(packet('off')); assert.equal(w.data[C.localDate()].x.consumeSec, 60);
    assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).access.x.remainingMs, 0);
    const restarted = worker(w.data, browser, w.now); const restored = await restarted.send({ type: 'access-status' });
    assert.equal(restored.access.x.enabled, false); assert.deepEqual(restarted.rules, w.rules);
  }
});
test('Limit & track On restores blocking immediately and requires a new access session', async () => {
  const w = worker({ settings: { trackedSites: ['linkedin'] } });
  w.tabs.push({ id: 1, url: 'https://x.com/home' }); await w.send({ type: 'access-status' });
  const on = await w.send(tracking('x', true), popupSender);
  assert.equal(on.access.x.enabled, true); assert.equal(on.access.x.remainingMs, 0); assert.deepEqual(w.rules, []);
  assert.equal(w.tabs[0].url, gate('x').url);
  await w.send(packet('before-session')); assert.equal(w.data[C.localDate()], undefined);
  await unlock(w); await w.send(packet('during-session')); assert.equal(w.data[C.localDate()].x.consumeSec, 5);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' }); w.advance(300000);
  await w.send(packet('after-session')); assert.equal(w.data[C.localDate()].x.consumeSec, 5);
});
test('failed Limit & track changes restore the previous setting and access rules', async () => {
  const w = worker(); await unlock(w); const before = structuredClone(w.data.settings || C.DEFAULT_SETTINGS);
  w.failRules = true; const result = await w.send(tracking('x', false), popupSender);
  assert.equal(result.ok, false); assert.deepEqual(w.data.settings, before); assert.ok(w.data._access.x.remainingMs > 0);
  w.failRules = false; assert.equal((await w.send(tracking('x', false), popupSender)).access.x.enabled, false);
});
test('goal-based access is opt-in, uses today’s exact score and keeps frame restrictions', async () => {
  for (const browser of ['chrome', 'browser']) {
    const date = C.localDate();
    const w = worker({ [date]: { x: { createSec: 121, consumeSec: 120 } } }, browser);
    assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, false);
    assert.deepEqual(w.rules, []);
    assert.equal((await w.send({ type: 'access-goal-setting', enabled: true }, popupSender)).ok, true);
    const result = await w.send({ type: 'access-status' });
    for (const site of ['x', 'linkedin']) {
      assert.equal(result.access[site].goalAllowed, true);
      assert.equal(result.access[site].remainingMs, 0);
      assert.equal(result.access[site].expiresAt, 0);
    }
    assert.equal(w.rules.length, 3);
    assert.deepEqual(w.rules.find(rule => rule.id === 101).condition.excludedResourceTypes, ['sub_frame']);
    assert.deepEqual(w.rules.find(rule => rule.id === 103).condition.initiatorDomains, ['linkedin.com']);
    assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, true);
    assert.equal(w.data._access, undefined, 'goal access creates no timed session');
    w.tabs.push({ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://www.linkedin.com/feed/' });
    assert.equal((await w.send(packet('fall-to-goal'))).ok, true);
    assert.deepEqual(w.rules, []);
    assert.equal(w.tabs[0].url, gate('x').url);
    assert.equal(w.tabs[1].url, gate('linkedin').url);
  }
  for (const day of [{}, { x: { createSec: 120, consumeSec: 120 } }, { x: { createSec: 119, consumeSec: 120 } }]) {
    const w = worker({ settings: { allowAboveGoal: true }, [C.localDate()]: day });
    assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, false);
    assert.deepEqual(w.rules, []);
  }
});
test('goal-based access follows the current configurable daily target, including mid-day changes', async () => {
  for (const browser of ['chrome', 'browser']) {
    const date = C.localDate();
    const w = worker({ settings: { allowAboveGoal: true, dailyTarget: 0.5 }, [date]: { x: { createSec: 90, consumeSec: 120 }, _dailyTarget: { target: 0.5, celebrated: true } } }, browser);
    assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, true, 'a score below 1.0 can exceed the configured goal');
    w.tabs.push({ id: 1, url: 'https://x.com/home' });
    w.data.settings.dailyTarget = 2;
    assert.equal((await w.send({ type: 'snapshot' })).access.x.goalAllowed, false, 'raising the goal immediately restores the gate');
    assert.deepEqual(w.rules, []); assert.equal(w.tabs[0].url, gate('x').url);
    w.data[date].x.createSec = 360;
    assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, true);
    w.data.settings.dailyTarget = 3;
    assert.equal((await w.send({ type: 'snapshot' })).access.x.goalAllowed, false, 'exactly meeting the current goal is not being above it');
    w.data.settings.dailyTarget = 4;
    assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, false, 'past achievements do not override the current goal');
    w.data.settings.dailyTarget = 0.1;
    assert.equal((await w.send({ type: 'snapshot' })).access.x.goalAllowed, true, 'lowering the goal immediately restores goal-based access');
    const restarted = worker(w.data, browser, w.now);
    assert.equal((await restarted.send({ type: 'access-status' })).access.x.goalAllowed, true);
  }
});

test('goal-based preference rejects untrusted senders and invalid values, and disabling revokes access', async () => {
  const w = worker({ [C.localDate()]: { x: { posts: 1 } } });
  const message = { type: 'access-goal-setting', enabled: true };
  assert.equal((await w.send(message)).ok, false);
  assert.equal((await w.send(message, { ...popupSender, frameId: 1 })).ok, false);
  for (const enabled of [1, 'true', null, undefined]) assert.equal((await w.send({ ...message, enabled }, popupSender)).ok, false);
  assert.equal(w.data.settings, undefined);
  await w.send(message, popupSender);
  w.tabs.push({ id: 1, url: 'https://x.com/home' });
  assert.equal((await w.send({ type: 'access-end', site: 'x' }, popupSender)).ok, false);
  assert.equal((await w.send({ ...message, enabled: false }, popupSender)).ok, true);
  assert.deepEqual(w.rules, []);
  assert.equal(w.tabs[0].url, gate('x').url);
});
test('goal-based access survives restart but yesterday’s score cannot unlock a new day', async () => {
  const now = new Date(2026, 9, 12, 23, 59, 30).getTime(), date = C.localDate(new Date(now));
  const first = worker({ settings: { allowAboveGoal: true }, [date]: { x: { posts: 1 } } }, 'chrome', now);
  assert.equal((await first.send({ type: 'access-status' })).access.x.goalAllowed, true);
  const w = worker(first.data, 'chrome', now);
  w.tabs.push({ id: 1, url: 'https://x.com/home' }); w.startup();
  assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, true);
  assert.equal(w.tabs[0].url, 'https://x.com/home');
  w.advance(60000); w.alarm('daily-badge');
  assert.equal((await w.send({ type: 'access-status' })).access.x.goalAllowed, false);
  assert.deepEqual(w.rules, []);
  assert.equal(w.tabs[0].url, gate('x').url);
});
test('goal-based access pauses an existing timed budget and resumes it below the goal', async () => {
  const w = worker(); await unlock(w);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' }); w.advance(10000);
  w.data[C.localDate()] = { x: { posts: 1 } };
  await w.send({ type: 'access-goal-setting', enabled: true }, popupSender);
  w.advance(600000);
  const above = await w.send({ type: 'access-status' });
  assert.equal(above.access.x.goalAllowed, true);
  assert.equal(above.access.x.remainingMs, 290000);
  assert.equal(above.access.x.expiresAt, 0);
  assert.equal(w.alarms['access-x'], undefined);
  w.data[C.localDate()].x.consumeSec = 120;
  const below = await w.send({ type: 'access-status' });
  assert.equal(below.access.x.goalAllowed, false);
  assert.equal(below.access.x.remainingMs, 290000);
  assert.equal(below.access.x.expiresAt, w.now + 290000);
  assert.equal(w.rules.length, 1);
});

test('intention history is opt-in, saves accepted requests once, and survives restart', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser), settingsPage = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
    assert.equal((await w.send({ type: 'access-status' })).intentionHistoryEnabled, false);
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    assert.equal(w.data._intentions, undefined);
    await w.send({ type: 'access-cancel', site: 'x' }, gate('x'));
    assert.equal((await w.send({ type: 'access-history-setting', enabled: true }, settingsPage)).ok, true);
    assert.equal((await w.send({ type: 'access-status' })).intentionHistoryEnabled, true);
    const message = { type: 'access-begin', site: 'x', reason: '  ' + intent + '  ' };
    await Promise.all([w.send(message, gate('x')), w.send(message, gate('x'))]);
    assert.deepEqual(w.data._intentions, [{ site: 'x', reason: intent, requestedAt: w.now }]);
    assert.equal(JSON.stringify(w.data._access).includes(intent), false);
    assert.equal(JSON.stringify(await w.send({ type: 'snapshot' })).includes(intent), false, 'activity snapshots do not expose private intentions');
    await w.send({ type: 'access-cancel', site: 'x' }, gate('x'));
    assert.equal(w.data._intentions.length, 1, 'cancelled waits remain reviewable');
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    const restarted = worker(w.data, browser, w.now + 60000);
    await restarted.send({ type: 'access-open', site: 'x' }, gate('x'));
    assert.equal(w.data._intentions.length, 2);
    await restarted.send({ type: 'access-history-setting', enabled: false }, settingsPage);
    await restarted.send({ type: 'access-begin', site: 'linkedin', reason: intent }, gate('linkedin'));
    assert.equal(w.data._intentions.length, 2, 'turning saving off preserves history but records no new text');
  }
});
test('intention history is bounded, excludes invalid requests, and clear only deletes intentions', async () => {
  const entries = Array.from({ length: 100 }, (_, requestedAt) => ({ site: 'x', reason: intent, requestedAt }));
  const w = worker({ settings: { intentionHistoryEnabled: true }, _intentions: entries, [C.localDate()]: { x: { consumeSec: 60 } } });
  assert.equal((await w.send({ type: 'access-begin', site: 'x', reason: 'short' }, gate('x'))).ok, false);
  assert.equal(w.data._intentions.length, 100);
  await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  assert.equal(w.data._intentions.length, 100); assert.equal(w.data._intentions[0].requestedAt, 1);
  const dashboard = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', frameId: 0 };
  const access = structuredClone(w.data._access);
  assert.deepEqual((await w.send({ type: 'access-history-list' }, dashboard)).intentions, w.data._intentions);
  assert.equal((await w.send({ type: 'access-history-clear' }, dashboard)).ok, true);
  assert.deepEqual((await w.send({ type: 'access-history-list' }, dashboard)).intentions, []);
  assert.deepEqual(w.data._intentions, []); assert.deepEqual(w.data._access, access);
  assert.equal(w.data[C.localDate()].x.consumeSec, 60); assert.equal(w.data.settings.intentionHistoryEnabled, true);
});
test('history preferences and clearing reject untrusted senders and malformed values', async () => {
  const w = worker({ _intentions: [{ site: 'x', reason: intent, requestedAt: 1 }] });
  const settingsPage = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
  for (const enabled of [undefined, 1, 'true']) assert.equal((await w.send({ type: 'access-history-setting', enabled }, settingsPage)).ok, false);
  for (const sender of [undefined, gate('x'), { ...settingsPage, frameId: 1 }, { ...settingsPage, id: 'other' }]) {
    assert.equal((await w.send({ type: 'access-history-setting', enabled: true }, sender)).ok, false);
  }
  const dashboard = { ...settingsPage, url: 'chrome-extension://test-extension/dashboard.html' };
  for (const sender of [undefined, gate('x'), settingsPage, { ...dashboard, frameId: 1 }, { ...dashboard, url: 'https://evil.test/dashboard.html' }]) {
    for (const type of ['access-history-clear', 'access-history-list']) assert.equal((await w.send({ type }, sender)).ok, false);
  }
  assert.equal(w.data._intentions.length, 1); assert.equal(w.data.settings, undefined);
});
test('a new unblock records a refill timestamp but repeated confirmation does not replay it', async () => {
  const w = worker(), result = await unlock(w);
  assert.equal(result.access.x.refilledAt, w.now);
  const refilledAt = w.now;
  w.advance(1000);
  const repeated = await w.send({ type: 'access-open', site: 'x' }, gate('x'));
  assert.equal(repeated.access.x.refilledAt, refilledAt);
  assert.equal(repeated.access.x.remainingMs, 300000);
});
test('whole-site access is blocked by default with no allow rules', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser), result = await w.send({ type: 'access-status' });
    assert.equal(result.ok, true);
    for (const site of ['x', 'linkedin']) assert.equal(result.access[site].expiresAt, 0);
    assert.deepEqual(w.rules, []);
  }
});
test('invalid intentions and unsupported senders return rejections without reporting worker crashes', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser);
    const response = await w.send({ type: 'access-begin', site: 'x', reason: 'short' }, gate('x'));
    assert.deepEqual(response, { ok: false, error: 'Write a specific intention of 20–280 characters.' });
    assert.deepEqual(await w.send(packet('unsupported'), { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://example.com' }), { ok: false, error: 'Unsupported sender' });
    assert.deepEqual(await w.send(packet('foreign'), { ...gate('x'), id: 'other-extension' }), { ok: false, error: 'Unsupported sender' });
    assert.equal(w.data._access, undefined);
    assert.equal(w.data[C.localDate()], undefined);
    assert.deepEqual(w.errors, [], 'expected rejections must not appear as extension errors');
    w.failRules = true;
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    w.advance(60000);
    assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
    assert.equal(w.errors.length, 1, 'unexpected API failures must still be reported');
    assert.match(w.errors[0][1].message, /Rule update failed/);
  }
});

test('unlock requires a specific intention, the full wait and explicit confirmation', async () => {
  const w = worker();
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  for (const reason of ['', 'short', ' '.repeat(20), 'a'.repeat(281)]) assert.equal((await w.send({ type: 'access-begin', site: 'x', reason }, gate('x'))).ok, false);
  const begin = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  assert.equal(begin.access.x.readyAt, w.now + 60000);
  assert.equal(JSON.stringify(w.data).includes(intent), false, 'intentions are not persisted by default');
  w.advance(59999);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  w.advance(1);
  assert.equal((await w.send({ type: 'access-status' })).access.x.expiresAt, 0, 'waiting alone never opens the site');
  const result = await w.send({ type: 'access-open', site: 'x' }, gate('x'));
  assert.equal(result.access.x.remainingMs, 300000);
  assert.equal(result.access.x.expiresAt, 0, 'access starts paused on the gate');
  assert.equal(result.access.linkedin.expiresAt, 0);
  assert.deepEqual(w.rules.map(rule => rule.condition.requestDomains), [['x.com', 'twitter.com']]);
  assert.deepEqual(w.rules[0].condition.excludedResourceTypes, ['sub_frame'], 'site resources unlock, embedded frames do not');
  assert.equal(w.rules[0].condition.resourceTypes, undefined);
  assert.equal(w.alarms['access-x'], undefined);
  w.activate('https://x.com/home');
  const active = await w.send({ type: 'access-status' });
  assert.equal(w.alarms['access-x'].when, active.access.x.expiresAt);
  assert.equal(active.access.x.expiresAt, w.now + 300000);
});
test('LinkedIn sessions allow its own app frames without opening embeds on other sites', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser); await unlock(w, 'linkedin');
    const frameRule = w.rules.find(rule => rule.condition.resourceTypes?.includes('sub_frame'));
    assert.ok(frameRule, 'LinkedIn navigation needs its same-site app frames');
    assert.equal(frameRule.action.type, 'allow');
    assert.equal(frameRule.priority, 2);
    assert.deepEqual(frameRule.condition.requestDomains, ['linkedin.com']);
    assert.deepEqual(frameRule.condition.initiatorDomains, ['linkedin.com'], 'unrelated sites must not gain an embed exception');
    assert.deepEqual(frameRule.condition.resourceTypes, ['sub_frame']);
    assert.deepEqual(w.rules.find(rule => rule.id === 102).condition.excludedResourceTypes, ['sub_frame']);
    frameRule.condition.initiatorDomains = ['example.com'];
    await w.send({ type: 'access-status' });
    assert.deepEqual(w.rules.find(rule => rule.id === frameRule.id).condition.initiatorDomains, ['linkedin.com']);
  }
});
test('LinkedIn frame exceptions survive worker restart but are revoked at expiry and manual end', async () => {
  for (const ending of ['expiry', 'manual']) {
    const first = worker(); await unlock(first, 'linkedin');
    const w = worker(first.data, 'chrome', first.now);
    await w.send({ type: 'access-status' });
    assert.equal(w.rules.length, 2);
    w.tabs.push({ id: 1, url: 'https://www.linkedin.com/notifications/' });
    w.activate(w.tabs[0].url); await w.send({ type: 'access-status' });
    if (ending === 'expiry') w.advance(300000);
    w.failRules = true;
    const message = ending === 'expiry' ? { type: 'access-status' } : { type: 'access-end', site: 'linkedin' };
    const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
    assert.equal((await w.send(message, popup)).ok, false);
    assert.equal(w.rules.length, 2, 'failed revocation retains both rules for retry');
    assert.ok(w.data._access.linkedin.remainingMs);
    w.failRules = false;
    assert.equal((await w.send(message, popup)).ok, true);
    assert.deepEqual(w.rules, []);
    assert.equal(w.tabs[0].url, gate('linkedin').url);
  }
});
test('content scripts, popup, spoofed gates and subframes cannot start or confirm access', async () => {
  const w = worker();
  const senders = [undefined, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, { ...gate('x'), url: 'https://evil.test/blocked.html?site=x' }, gate('linkedin'), { ...gate('x'), frameId: 1 }, { ...gate('x'), id: 'other-extension' }, { ...gate('x'), url: 'chrome-extension://other-extension/blocked.html?site=x' }];
  for (const sender of senders) {
    assert.equal((await w.send({ type: 'access-begin', site: 'x', reason: intent }, sender)).ok, false);
    assert.equal((await w.send({ type: 'access-open', site: 'x' }, sender)).ok, false);
  }
  assert.deepEqual(w.rules, []);
});
test('rejects unknown sites and inherited object keys without persisting access', async () => {
  const w = worker();
  for (const site of ['unknown', 'constructor', '__proto__', 'toString']) {
    assert.equal((await w.send({ type: 'access-begin', site, reason: intent }, gate(site))).ok, false);
    assert.equal((await w.send({ type: 'access-open', site }, gate(site))).ok, false);
  }
  assert.equal(w.data._access, undefined); assert.deepEqual(w.rules, []);
});
test('concurrent gates share a wait and repeated opens cannot extend a session', async () => {
  const w = worker();
  await Promise.all([w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x')), w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'))]);
  const readyAt = w.data._access.x.readyAt;
  w.advance(30000);
  await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  assert.equal(w.data._access.x.readyAt, readyAt);
  w.advance(30000);
  const results = await Promise.all([w.send({ type: 'access-open', site: 'x' }, gate('x')), w.send({ type: 'access-open', site: 'x' }, gate('x'))]);
  assert.equal(results[0].access.x.remainingMs, 300000);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(20000);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).access.x.remainingMs, 280000);
  assert.equal((await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'))).access.x.remainingMs, 280000);
});
test('wait survives a worker restart but abandoned requests expire', async () => {
  const first = worker();
  await first.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  const restarted = worker(first.data, 'chrome', first.now + 60000);
  assert.equal((await restarted.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, true);
  const abandoned = worker();
  await abandoned.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  abandoned.advance(660000);
  assert.equal((await abandoned.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
});
test('expiry revokes access and redirects all matching open tabs, not unrelated sites', async () => {
  const w = worker(); await unlock(w);
  w.tabs.push({ id: 1, url: 'https://x.com/compose/post' }, { id: 2, url: 'http://mobile.twitter.com/home' }, { id: 3, url: 'https://x.com.evil.test/home' }, { id: 4, url: 'https://www.linkedin.com/feed/' });
  w.activate('https://x.com/compose/post'); await w.send({ type: 'access-status' });
  w.advance(300000); w.alarm('access-x');
  const result = await w.send({ type: 'access-status' });
  assert.equal(result.access.x.expiresAt, 0);
  assert.deepEqual(w.rules, []);
  assert.equal(w.tabs[0].url, gate('x').url); assert.equal(w.tabs[1].url, gate('x').url);
  assert.equal(w.tabs[2].url, 'https://x.com.evil.test/home'); assert.equal(w.tabs[3].url, 'https://www.linkedin.com/feed/');
  assert.equal(w.data._access.x.expiresAt, undefined);
});
test('startup restores unused budgets, migrates legacy deadlines and blocks pre-existing tabs on install', async () => {
  const first = worker(); await unlock(first);
  const resumed = worker(structuredClone(first.data), 'chrome', first.now + 1000000);
  resumed.startup();
  assert.equal((await resumed.send({ type: 'access-status' })).access.x.remainingMs, 300000);
  assert.equal(resumed.rules.length, 1);
  const legacy = worker({ _access: { x: { expiresAt: first.now + 300000 } } }, 'chrome', first.now + 100000);
  assert.equal((await legacy.send({ type: 'access-status' })).access.x.remainingMs, 200000);
  const expired = worker({ _access: { x: { expiresAt: first.now + 300000 } } }, 'chrome', first.now + 300000);
  expired.tabs.push({ id: 1, url: 'https://x.com/home' }); expired.startup();
  assert.equal((await expired.send({ type: 'access-status' })).access.x.expiresAt, 0);
  assert.deepEqual(expired.rules, []); assert.equal(expired.tabs[0].url, gate('x').url);
  const fresh = worker(); fresh.tabs.push({ id: 1, url: 'https://www.linkedin.com/messaging/' }); fresh.install();
  await fresh.send({ type: 'access-status' }); assert.equal(fresh.tabs[0].url, gate('linkedin').url);
});
test('worker wake or re-enable blocks existing tabs even without an expired session', async () => {
  const w = worker(); w.tabs.push({ id: 1, url: 'https://x.com/home' });
  await w.send({ type: 'access-status' });
  assert.equal(w.tabs[0].url, gate('x').url);
});
test('both sites have independent sessions and ending one does not end the other', async () => {
  const w = worker(); await unlock(w, 'x'); await unlock(w, 'linkedin');
  assert.equal(w.rules.length, 3);
  const result = await w.send({ type: 'access-end', site: 'x' }, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' });
  assert.equal(result.ok, true); assert.equal(result.access.x.expiresAt, 0); assert.ok(result.access.linkedin.remainingMs);
  assert.deepEqual(w.rules.map(rule => rule.id), [102, 103]);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
});
test('cancelling a wait forces a new full wait', async () => {
  const w = worker();
  await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x')); w.advance(60000);
  await w.send({ type: 'access-cancel', site: 'x' }, gate('x'));
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  const result = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  assert.equal(result.access.x.readyAt, w.now + 60000);
});
test('failed rule revocation preserves the running budget for a retry', async () => {
  const w = worker(); await unlock(w);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(300000); w.failRules = true;
  assert.equal((await w.send({ type: 'access-status' })).ok, false);
  assert.ok(w.data._access.x.remainingMs);
  w.failRules = false;
  assert.equal((await w.send({ type: 'access-status' })).access.x.expiresAt, 0);
  assert.deepEqual(w.rules, []);
});

const tracking = (site, enabled) => ({ type: 'tracking', site, enabled });
test('settings page in a tab can save all preferences but spoofed pages and subframes cannot', async () => {
  const w = worker(); w.grantWebsitePermissions();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', tab: { id: 3 }, frameId: 0 };
  const messages = [tracking('x', false), { type: 'website-time-setting', enabled: true }, { type: 'access-duration', minutes: 12 }, { type: 'access-duration', site: 'x', minutes: 2 }];
  for (const message of messages) {
    for (const bad of [{ ...sender, frameId: 1 }, { ...sender, url: 'https://evil.test/settings.html' }, { ...sender, url: 'chrome-extension://other/settings.html' }, { ...sender, url: 'chrome-extension://test-extension/dashboard.html' }, { id: 'test-extension' }]) assert.equal((await w.send(message, bad)).ok, false);
    assert.equal((await w.send(message, sender)).ok, true);
  }
  assert.equal(w.data.settings.siteOverrides.x.accessMinutes, 2); assert.equal(w.data.settings.accessMinutes, 12);
  assert.deepEqual(w.data.settings.trackedSites, ['linkedin']); assert.equal(w.data._websiteTimeEnabled, true);
});

test('slow scrolling rejects foreign, content and framed senders and non-boolean preferences', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser);
    const settingsPage = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
    assert.equal((await w.send({ type: 'snapshot' })).settings.scrollFrictionEnabled, true);
    for (const enabled of [undefined, null, 1, 'true', [], {}]) {
      assert.equal((await w.send({ type: 'scroll-friction-setting', enabled }, settingsPage)).ok, false);
    }
    for (const sender of [undefined, gate('x'), { ...settingsPage, frameId: 1 }, { ...settingsPage, id: 'other' }, { ...settingsPage, url: 'https://evil.test/settings.html' }]) {
      assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: false }, sender)).ok, false);
    }
    assert.equal(w.data.settings, undefined); assert.deepEqual(w.errors, []);
    w.failWrites = true;
    assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: false }, settingsPage)).ok, false);
    assert.equal(w.data.settings, undefined);
    w.failWrites = false;
    assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: false }, settingsPage)).settings.scrollFrictionEnabled, false);
  }
});
test('resistance saves validate atomically, preserve history and survive boolean-only toggles and restart', async () => {
  for (const browser of ['chrome', 'browser']) {
    const date = C.localDate();
    const data = { settings: { scrollFrictionEnabled: true, scrollFrictionStrength: 75 }, [date]: { x: { consumeSec: 30 } } };
    const w = worker(data, browser);
    for (const strength of [null, '50', true, 0, -5, 5, 25, 45, 99, 100, 1, 50.5, NaN, Infinity, [], {}]) {
      assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: false, strength }, popupSender)).ok, false);
      assert.equal(data.settings.scrollFrictionEnabled, true); assert.equal(data.settings.scrollFrictionStrength, 75);
    }
    assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: false }, popupSender)).settings.scrollFrictionStrength, 75);
    for (const strength of [50, 75, 90, 95]) {
      assert.equal((await w.send({ type: 'scroll-friction-setting', enabled: true, strength }, popupSender)).settings.scrollFrictionStrength, strength);
    }
    const restarted = worker(data, browser, w.now);
    assert.equal((await restarted.send({ type: 'snapshot' })).settings.scrollFrictionStrength, 95);
    assert.equal(data[date].x.consumeSec, 30);
    assert.deepEqual(w.errors, []);
  }
});
test('saved zero resistance stays Off until enabled with a valid strength, including boolean-only commands', async () => {
  for (const browser of ['chrome', 'browser']) {
    const settings = { scrollFrictionEnabled: true, scrollFrictionStrength: 0, accessMinutes: 12, nudgeEnabled: false };
    const data = { settings: { ...settings } }, w = worker(data, browser);
    const restored = (await w.send({ type: 'snapshot' })).settings;
    assert.equal(restored.scrollFrictionEnabled, false); assert.equal(restored.scrollFrictionStrength, 50);
    assert.deepEqual(data.settings, settings);
    const enabled = await w.send({ type: 'scroll-friction-setting', enabled: true }, popupSender);
    assert.equal(enabled.ok, true); assert.equal(enabled.settings.scrollFrictionEnabled, true); assert.equal(enabled.settings.scrollFrictionStrength, 50);
    assert.deepEqual(data.settings, { ...settings, scrollFrictionStrength: 50 });
    const restarted = worker(data, browser, w.now);
    const result = (await restarted.send({ type: 'snapshot' })).settings;
    assert.equal(result.scrollFrictionEnabled, true); assert.equal(result.scrollFrictionStrength, 50);
  }
});
test('fresh profiles track X and LinkedIn by default', async () => {
  const w = worker();
  const result = await w.send({ type: 'snapshot' });
  assert.deepEqual(result.settings.trackedSites, ['x', 'linkedin']);
  assert.equal(result.settings.nudgeMinutes, undefined); assert.equal(result.settings.nudgeEnabled, undefined);
});
test('turning Limit & track off drops time and actions, preserves history, and unblocks the site', async () => {
  const w = activeWorker();
  await w.send(packet('before'));
  const result = await w.send(tracking('x', false), popupSender);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.trackedSites, ['linkedin']);
  assert.equal(result.access.x.expiresAt, 0);
  assert.equal(result.day.x.consumeSec, 5);
  const after = packet('disabled'); after.actions = [{ date: C.localDate(), action: 'posts' }];
  assert.equal((await w.send(after)).ok, true);
  assert.equal(w.data[C.localDate()].x.consumeSec, 5);
  assert.equal(w.data[C.localDate()].x.posts, 0);
  assert.deepEqual(w.data._receipts, ['before']);
  assert.equal(result.access.x.enabled, false); assert.deepEqual(w.rules[0].condition.requestDomains, ['x.com', 'twitter.com']);
  const restarted = worker(w.data);
  assert.equal((await restarted.send(packet('restart-disabled'))).ok, true);
  assert.equal(w.data[C.localDate()].x.consumeSec, 5);
  await restarted.send(tracking('x', true), popupSender); await unlock(restarted);
  await restarted.send(packet('enabled'));
  assert.equal(w.data[C.localDate()].x.consumeSec, 10);
  assert.deepEqual((await restarted.send({ type: 'snapshot' })).settings.trackedSites, ['x', 'linkedin']);
});
test('all creation tracking can be disabled; concurrent access changes preserve the selection', async () => {
  const w = worker();
  const results = await Promise.all([
    w.send(tracking('x', false), popupSender),
    w.send(tracking('linkedin', false), popupSender),
    w.send({ type: 'access-duration', minutes: 7 }, popupSender)
  ]);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(w.data.settings.trackedSites, []);
  assert.equal(w.data.settings.accessMinutes, 7);
  assert.equal((await w.send(packet('no-tracking'))).ok, true);
  assert.equal(w.data[C.localDate()], undefined);
  assert.equal(C.csv(w.data).trim().split('\r\n').length, 1);
});
test('tracking preferences reject unvetted sites, invalid flags and untrusted senders', async () => {
  const w = worker();
  for (const site of ['unknown', '__proto__', 'constructor', null]) assert.equal((await w.send(tracking(site, true), popupSender)).ok, false);
  for (const enabled of ['false', 0, null]) assert.equal((await w.send(tracking('x', enabled), popupSender)).ok, false);
  for (const sender of [undefined, { id: 'test-extension' }, gate('x'), { ...popupSender, url: 'https://evil.test/popup.html' }, { ...popupSender, id: 'other-extension' }]) assert.equal((await w.send(tracking('x', false), sender)).ok, false);
  assert.equal(w.data.settings, undefined);
  assert.equal((await w.send(tracking('x', false), { ...popupSender, tab: { id: 9 }, frameId: 1 })).ok, false);
  assert.equal((await w.send(tracking('x', false), { ...popupSender, tab: { id: 9 }, frameId: 0 })).ok, true, 'the trusted popup also works when opened as an extension tab');
  assert.equal((await w.send(packet('unsupported', null), { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://example.com' })).ok, false);
});


test('access budget pauses away from the site and resumes across tabs without double counting', async () => {
  const w = worker(); await unlock(w);
  w.advance(600000);
  let state = (await w.send({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 300000, 'unused access must not expire');
  assert.equal(state.expiresAt, 0, 'paused sessions have no wall-clock deadline');
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(20000); w.activate('https://twitter.com/home', 2);
  state = (await w.send({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 280000);
  w.advance(10000); w.activate('https://example.com'); await w.send({ type: 'access-status' });
  w.advance(600000);
  state = (await w.send({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 270000);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(10000); w.blur(); await w.send({ type: 'access-status' });
  w.advance(600000);
  assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 260000);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(260000); w.alarm('access-x');
  assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 0);
  assert.deepEqual(w.rules, []);
});

test('navigation and closing the active tab pause access without storing tab IDs or URLs', async () => {
  for (const browser of ['chrome', 'browser']) {
    const w = worker({}, browser); await unlock(w);
    w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
    w.advance(5000); w.navigate('https://example.com/private'); await w.send({ type: 'access-status' });
    w.advance(600000);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 295000);
    w.navigate('https://x.com/compose/post'); await w.send({ type: 'access-status' });
    w.advance(5000); w.removeActive(); await w.send({ type: 'access-status' });
    w.advance(600000);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 290000);
    assert.equal(JSON.stringify(w.data._access).includes('https://'), false);
    assert.equal(JSON.stringify(w.data._access).includes('tabId'), false);
  }
});

test('worker restart preserves the checkpointed active budget without charging browser downtime', async () => {
  const w = worker(); await unlock(w);
  w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
  w.advance(30000); await w.send({ type: 'access-status' });
  const resumed = worker(w.data, 'chrome', w.now + 1000000);
  resumed.startup();
  assert.equal((await resumed.send({ type: 'access-status' })).access.x.remainingMs, 270000);
  resumed.activate('https://x.com/home'); await resumed.send({ type: 'access-status' });
  resumed.advance(5000);
  assert.equal((await resumed.send({ type: 'access-status' })).access.x.remainingMs, 265000);
});

test('site overrides persist, inherit changed defaults, and only affect new sessions', async () => {
  const w = worker({ settings: { nudgeEnabled: true, nudgeMinutes: 1, siteOverrides: { x: { nudgeEnabled: true, nudgeMinutes: 3 } } } });
  const access = minutes => ({ type: 'access-duration', site: 'x', minutes });
  assert.equal((await w.send(access(2), popupSender)).ok, true);
  assert.equal((await w.send({ type: 'access-duration', minutes: 12 }, popupSender)).ok, true);
  const statuses = (await w.send({ type: 'access-status' })).access;
  assert.equal(statuses.x.sessionMinutes, 2); assert.equal(statuses.linkedin.sessionMinutes, 12);
  assert.equal((await unlock(w)).access.x.remainingMs, 120000);
  assert.equal((await unlock(w, 'linkedin')).access.linkedin.remainingMs, 720000);
  assert.equal((await w.send(access(null), popupSender)).ok, true);
  assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 120000);
  assert.deepEqual(w.data.settings.siteOverrides.x, { nudgeEnabled: true, nudgeMinutes: 3 });
  const restarted = worker(w.data, 'chrome', w.now + 600000);
  const snapshot = await restarted.send({ type: 'snapshot' });
  assert.equal(snapshot.access.x.sessionMinutes, 12); assert.equal(snapshot.access.x.remainingMs, 120000);
  assert.equal(C.siteSettings('x', snapshot.settings).nudgeMinutes, undefined);
  assert.equal(snapshot.settings.nudgeEnabled, undefined); assert.deepEqual(snapshot.settings.siteOverrides, {});
  await restarted.send({ type: 'access-end', site: 'x' }, popupSender);
  assert.equal((await unlock(restarted)).access.x.remainingMs, 720000);
});
test('concurrent site preferences preserve siblings, creation tracking, history and defaults', async () => {
  const w = worker({ [C.localDate()]: { x: { consumeSec: 60 } }, settings: { siteOverrides: { x: { nudgeEnabled: false, nudgeMinutes: 3 } } } });
  const results = await Promise.all([
    w.send({ type: 'access-duration', site: 'x', minutes: 2 }, popupSender),
    w.send({ type: 'access-duration', site: 'linkedin', minutes: 20 }, popupSender),
    w.send({ type: 'access-duration', minutes: 15 }, popupSender),
    w.send(tracking('x', false), popupSender)
  ]);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(w.data.settings.siteOverrides, { x: { accessMinutes: 2, nudgeEnabled: false, nudgeMinutes: 3 }, linkedin: { accessMinutes: 20 } });
  assert.deepEqual(w.data.settings.trackedSites, ['linkedin']);
  await w.send({ type: 'access-duration', site: 'x', minutes: null }, popupSender);
  assert.deepEqual(w.data.settings.siteOverrides.x, { nudgeEnabled: false, nudgeMinutes: 3 });
  assert.equal(C.siteSettings('x', w.data.settings).accessMinutes, 15); assert.equal(C.siteSettings('x', w.data.settings).nudgeEnabled, undefined);
  assert.equal(w.data.settings.siteOverrides.linkedin.accessMinutes, 20); assert.equal(w.data[C.localDate()].x.consumeSec, 60);
});
test('site overrides reject invalid values, unvetted IDs and untrusted senders without writes', async () => {
  const w = worker();
  for (const site of ['unknown', '__proto__', 'constructor', '', null]) {
    assert.equal((await w.send({ type: 'access-duration', site, minutes: 2 }, popupSender)).ok, false);
    assert.equal((await w.send({ type: 'settings', site, nudgeEnabled: true, nudgeMinutes: 2 }, popupSender)).ok, false);
  }
  for (const minutes of [0, 241, 1.5, '2', undefined]) {
    assert.equal((await w.send({ type: 'access-duration', site: 'x', minutes }, popupSender)).ok, false);
    assert.equal((await w.send({ type: 'settings', site: 'x', nudgeEnabled: true, nudgeMinutes: minutes }, popupSender)).ok, false);
  }
  for (const message of [{ type: 'access-duration', site: 'x', minutes: null }, { type: 'settings', site: 'x', nudgeEnabled: null, nudgeMinutes: null }]) {
    for (const sender of [undefined, gate('x'), { ...popupSender, frameId: 1 }]) assert.equal((await w.send(message, sender)).ok, false);
  }
  assert.equal(w.data.settings, undefined);
});
test('retired nudge commands cannot change preferences or appear in runtime snapshots', async () => {
  const stored = { nudgeEnabled: true, nudgeMinutes: 1, siteOverrides: { x: { accessMinutes: 2, nudgeEnabled: true, nudgeMinutes: 1 }, linkedin: { nudgeEnabled: true } } };
  const w = worker({ settings: structuredClone(stored) });
  assert.equal((await w.send({ type: 'settings', nudgeEnabled: true, nudgeMinutes: 1 }, popupSender)).ok, false);
  const snapshot = await w.send({ type: 'snapshot' });
  assert.equal(snapshot.settings.nudgeEnabled, undefined); assert.equal(snapshot.settings.nudgeMinutes, undefined);
  assert.deepEqual(snapshot.settings.siteOverrides, { x: { accessMinutes: 2 } }); assert.deepEqual(w.data.settings, stored);
});
test('Limit & track uses the session timer on creating pages, while Off has no timer or block', async () => {
  for (const enabled of [true, false]) {
    const w = worker({ settings: { accessMinutes: 1, trackedSites: enabled ? ['x', 'linkedin'] : ['linkedin'], nudgeEnabled: true, nudgeMinutes: 1 } });
    if (enabled) await unlock(w);
    w.tabs.push({ id: 1, url: 'https://x.com/compose/post' }); w.activate('https://x.com/compose/post'); await w.send({ type: 'access-status' });
    w.advance(60000); const status = await w.send({ type: 'access-status' });
    assert.equal(status.access.x.enabled, enabled); assert.equal(status.access.x.remainingMs, 0);
    assert.equal(w.tabs[0].url, enabled ? 'chrome-extension://test-extension/blocked.html?site=x' : 'https://x.com/compose/post');
    assert.equal(w.rules.length, enabled ? 0 : 2);
  }
});
test('access duration is validated, persisted and only affects new sessions until midnight', async () => {
  const w = worker();
  const message = { type: 'access-duration', minutes: 12 };
  assert.equal((await w.send(message)).ok, false);
  for (const minutes of [0, 241, 1.5, '12', null]) {
    assert.equal((await w.send({ ...message, minutes }, popupSender)).ok, false);
  }
  assert.equal((await w.send(message, popupSender)).ok, true);
  assert.equal(w.data.settings.accessMinutes, 12);
  assert.equal((await unlock(w)).access.x.remainingMs, 720000);
  await w.send({ ...message, minutes: 2 }, popupSender);
  assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 720000);
  const restarted = worker(w.data, 'chrome', w.now + 600000);
  assert.equal((await restarted.send({ type: 'access-status' })).access.x.remainingMs, 720000);
  assert.equal((await unlock(restarted, 'linkedin')).access.linkedin.remainingMs, 120000);
});

const dashboardSender = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', frameId: 0 };
test('history reads reject content scripts, malformed ranges and subframes', async () => {
  const w = worker(), message = { type: 'history', kind: 'ratio', range: 'week' };
  assert.equal((await w.send(message)).ok, false);
  assert.equal((await w.send(message, { ...dashboardSender, frameId: 1 })).ok, false);
  assert.equal((await w.send({ ...message, range: 'all' }, dashboardSender)).ok, false);
  assert.equal((await w.send({ ...message, kind: 'settings' }, dashboardSender)).ok, false);
  assert.equal((await w.send(message, dashboardSender)).ok, true);
});
test('expired and future packets are acknowledged without recreating history', async () => {
  const w = worker({ _access: { x: { remainingMs: 300000 } } }, 'chrome', new Date(2026, 9, 31, 12).getTime()), p = packet('old-packet');
  p.segments = [{ date: '2026-10-01', mode: 'create', sec: 5 }, { date: '2026-11-01', mode: 'consume', sec: 5 }];
  p.actions = [{ date: '2026-10-01', action: 'posts' }];
  assert.equal((await w.send(p)).ok, true);
  assert.equal(w.data['2026-10-01'], undefined); assert.equal(w.data['2026-11-01'], undefined);
  assert.deepEqual(w.data._receipts, ['old-packet']);
});
test('clear history is restricted and preserves settings, opt-in and retry deduplication', async () => {
  const w = worker(); await unlock(w); await w.send(packet('recorded'));
  const settings = { ...C.DEFAULT_SETTINGS, accessMinutes: 12 }; w.data.settings = settings;
  const access = structuredClone(w.data._access);
  assert.equal((await w.send({ type: 'clear-history' })).ok, false);
  assert.equal(w.data[C.localDate()].x.consumeSec, 5);
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
  assert.equal((await w.send({ type: 'clear-history' }, sender)).ok, true);
  assert.equal(w.data[C.localDate()], undefined); assert.deepEqual(w.data.settings, settings); assert.deepEqual(w.data._access, access);
  await w.send(packet('recorded')); assert.equal(w.data[C.localDate()], undefined);
  const { generation } = await w.send({ type: 'snapshot' });
  await w.send({ ...packet('new'), generation }); assert.equal(w.data[C.localDate()].x.consumeSec, 5);
});
test('clear history resets the website time sample without backfilling the prior interval', async () => {
  const w = worker(); w.grantWebsitePermissions(); w.activate('https://example.com');
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html', frameId: 0 };
  await w.send({ type: 'website-time-setting', enabled: true }, sender); w.advance(5000);
  await w.send({ type: 'snapshot' }); assert.equal(w.data['_websiteTime:' + C.localDate()]['example.com'], 5);
  w.advance(3000); await w.send({ type: 'clear-history' }, sender);
  assert.equal(w.data['_websiteTime:' + C.localDate()], undefined); assert.equal(w.data._websiteTimeEnabled, true);
  w.advance(2000); await w.send({ type: 'snapshot' });
  assert.equal(w.data['_websiteTime:' + C.localDate()]['example.com'], 2);
});

test('paused access refills at local midnight using the current configured duration once per day', async () => {
  for (const browser of ['chrome', 'browser']) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({}, browser, midnight - 120000); await unlock(w);
    w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
    w.advance(10000); w.blur(); await w.send({ type: 'access-status' });
    await w.send({ type: 'access-duration', minutes: 12 }, popupSender);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 290000);
    w.advance(50000); w.alarm('access-midnight');
    let state = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 720000);
    assert.equal(state.refilledAt, midnight);
    assert.equal(state.expiresAt, 0);
    assert.equal(w.rules.length, 1);
    assert.equal(w.alarms['access-midnight'].when, new Date(2026, 9, 13).getTime());
    w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
    w.advance(5000); w.alarm('access-midnight');
    state = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 715000, 'duplicate alarms must not refill again');
    assert.equal(state.refilledAt, midnight, 'countdown ticks retain the original refill timestamp');
  }
});

test('running access refills at midnight without blocking the tab and charges only time in the new day', async () => {
  for (const delay of [0, 10000]) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({}, 'chrome', midnight - 120000); await unlock(w);
    w.tabs.push({ id: 1, url: 'https://x.com/home' });
    w.activate(w.tabs[0].url); await w.send({ type: 'access-status' });
    w.advance(60000 + delay); w.alarm('access-midnight');
    const state = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 300000 - delay);
    assert.equal(state.expiresAt, midnight + 300000);
    assert.equal(w.alarms['access-x'].when, midnight + 300000);
    assert.equal(w.tabs[0].url, 'https://x.com/home');
  }
});

test('restart after missed midnights refills unused access without charging browser downtime', async () => {
  const midnight = new Date(2026, 9, 12).getTime();
  const first = worker({}, 'chrome', midnight - 120000); await unlock(first);
  first.activate('https://x.com/home'); await first.send({ type: 'access-status' });
  first.advance(10000); await first.send({ type: 'access-status' });
  const w = worker(first.data, 'chrome', new Date(2026, 9, 15, 12).getTime()); w.startup();
  const state = (await w.send({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 300000);
  assert.equal(state.expiresAt, 0);
  assert.equal(w.alarms['access-midnight'].when, new Date(2026, 9, 16).getTime());
});

test('midnight does not unlock never-opened or ended sessions or skip intention waits', async () => {
  for (const ending of ['never', 'manual', 'waiting']) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({}, 'chrome', midnight - 600000);
    if (ending === 'manual') {
      await unlock(w);
      await w.send({ type: 'access-end', site: 'x' }, popupSender);
    } else if (ending === 'waiting') {
      w.advance(570000);
      await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    }
    w.advance(midnight - w.now); w.alarm('access-midnight');
    const result = await w.send({ type: 'access-status' });
    assert.equal(result.access.x.remainingMs, 0, ending);
    assert.equal(result.access.linkedin.remainingMs, 0, ending);
    assert.deepEqual(w.rules, [], ending);
    assert.equal(w.alarms['access-midnight'], undefined, ending);
    if (ending === 'waiting') assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  }
});

test('exhausted access refills at midnight even if expiry was reconciled late', async () => {
  for (const checkExpiry of [true, false]) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({}, 'chrome', midnight - 600000); await unlock(w);
    w.activate('https://x.com/home'); await w.send({ type: 'access-status' });
    w.advance(300000);
    if (checkExpiry) {
      assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 0);
      assert.deepEqual(w.rules, []);
      assert.equal(w.alarms['access-midnight'].when, midnight);
    }
    w.advance(midnight - w.now); w.alarm('access-midnight');
    const state = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 300000);
    assert.equal(w.rules.length, 1);
  }
});

test('midnight refills use current per-site overrides and inherited Default independently', async () => {
  for (const browser of ['chrome', 'browser']) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({ settings: { accessMinutes: 12, siteOverrides: { x: { accessMinutes: 2 } } } }, browser, midnight - 240000);
    await unlock(w, 'x'); await unlock(w, 'linkedin');
    await w.send({ type: 'access-duration', site: 'x', minutes: 4 }, popupSender);
    await w.send({ type: 'access-duration', minutes: 15 }, popupSender);
    let states = (await w.send({ type: 'access-status' })).access;
    assert.equal(states.x.remainingMs, 120000); assert.equal(states.linkedin.remainingMs, 720000);
    w.advance(midnight - w.now); w.alarm('access-midnight');
    states = (await w.send({ type: 'access-status' })).access;
    assert.equal(states.x.remainingMs, 240000); assert.equal(states.linkedin.remainingMs, 900000);
    assert.equal(states.x.refilledAt, midnight); assert.equal(states.linkedin.refilledAt, midnight);
    assert.equal(states.x.sessionMinutes, 4); assert.equal(states.linkedin.sessionMinutes, 15);
    assert.equal(states.x.expiresAt, 0); assert.equal(states.linkedin.expiresAt, 0);
    await w.send({ type: 'access-duration', site: 'x', minutes: null }, popupSender);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 240000);
    w.advance(86400000); w.alarm('access-midnight');
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 900000);
  }
});
test('Off cancels midnight refills and pending waits without deleting intention history', async () => {
  for (const browser of ['chrome', 'browser']) {
    const midnight = new Date(2026, 9, 12).getTime();
    const w = worker({ settings: { intentionHistoryEnabled: true, siteOverrides: { x: { accessMinutes: 2 } } } }, browser, midnight - 120000);
    await unlock(w); assert.equal(w.alarms['access-midnight'].when, midnight);
    await w.send(tracking('x', false), popupSender);
    assert.equal(w.alarms['access-midnight'], undefined); assert.equal(w.data._access.x, undefined);
    w.advance(midnight - w.now); w.alarm('access-midnight');
    let state = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(state.enabled, false); assert.equal(state.remainingMs, 0); assert.equal(state.refilledAt, 0);
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    assert.equal(w.data._intentions.length, 1); assert.equal(w.data._access.x, undefined);
    state = (await w.send(tracking('x', true), popupSender)).access.x;
    assert.equal(state.remainingMs, 0); assert.equal(state.readyAt, 0); assert.equal(state.sessionMinutes, 2);
    assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    await w.send(tracking('x', false), popupSender);
    assert.equal(w.data._access.x, undefined); assert.equal(w.data._intentions.length, 2);
    assert.equal(w.data.settings.siteOverrides.x.accessMinutes, 2);
  }
});
test('above-goal access tracks enabled sites but never overrides Off or saves Off intentions', async () => {
  for (const browser of ['chrome', 'browser']) {
    const date = C.localDate();
    const w = worker({ settings: { allowAboveGoal: true, intentionHistoryEnabled: true, trackedSites: ['linkedin'] }, [date]: { x: { createSec: 121, consumeSec: 120 } } }, browser);
    const states = (await w.send({ type: 'access-status' })).access;
    assert.equal(states.x.enabled, false); assert.equal(states.x.goalAllowed, false);
    assert.equal(states.linkedin.enabled, true); assert.equal(states.linkedin.goalAllowed, true);
    await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    await w.send(packet('off-above-goal'));
    assert.equal(w.data._intentions, undefined); assert.equal(w.data._access, undefined);
    assert.equal(w.data[date].x.consumeSec, 120);
    const result = await w.send(packet('goal-tracked', 'linkedin'), { id: 'test-extension', tab: { id: 2 }, frameId: 0, url: 'https://www.linkedin.com/feed/' });
    assert.equal(result.ok, true); assert.equal(w.data[date].linkedin.consumeSec, 5);
    assert.equal(result.access.linkedin.goalAllowed, false); assert.equal(result.access.x.enabled, false);
    assert.deepEqual(w.rules.map(rule => rule.id), [101, 104]);
    assert.equal((await w.send(tracking('x', true), popupSender)).access.x.remainingMs, 0);
    await unlock(w); assert.equal(w.data._intentions.length, 1);
  }
});
test('midnight alarm follows the local calendar across daylight-saving changes', async () => {
  for (const [month, day] of [[2, 8], [10, 1]]) {
    const start = new Date(2026, month, day).getTime();
    const w = worker({}, 'chrome', start - 120000); await unlock(w);
    assert.equal(w.alarms['access-midnight'].when, start);
    w.advance(60000); w.alarm('access-midnight'); await w.send({ type: 'access-status' });
    assert.equal(w.alarms['access-midnight'].when, new Date(2026, month, day + 1).getTime());
  }
});

async function drainMessages() {
  for (let n = 0; n < 50; n++) await new Promise(resolve => setImmediate(resolve));
}

test('clear invalidates partial intervals across tabs and requires fresh input through real runtime messages', async () => {
  for (const browser of ['chrome', 'browser']) {
    const start = new Date(2026, 9, 11, 12).getTime(), w = worker({}, browser, start - 60000);
    await unlock(w);
    const first = await tracker(browser, { forward: message => w.send(message) });
    const second = await tracker(browser, { forward: message => w.send(message) });
    await drainMessages();
    first.input(); second.input(); first.setNow(2000); second.setNow(2000); w.advance(2000);
    const cleared = await w.send({ type: 'clear-history' }, popupSender);
    assert.equal(cleared.ok, true); assert.equal(typeof cleared.generation, 'string');
    first.setNow(5000); second.setNow(5000); w.advance(3000);
    await first.tick(); await second.tick(); await drainMessages();
    assert.equal(w.data['2026-10-11'], undefined);
    first.setNow(10000); second.setNow(10000); w.advance(5000);
    await first.tick(); await second.tick(); await drainMessages();
    assert.equal(w.data['2026-10-11'], undefined, 'pre-clear input cannot resume');
    first.input(); first.setNow(15000); w.advance(5000);
    await first.tick(); await drainMessages();
    assert.equal(w.data['2026-10-11'].x.consumeSec, 5);
  }
});

test('clear while retrying rejects old generations across worker loads and retains receipt deduplication', async () => {
  const start = new Date(2026, 9, 11, 12).getTime();
  let w = worker({ _intentions: [{ site: 'x', reason: intent, requestedAt: start }], _receipts: ['preserved'] }, 'chrome', start - 60000);
  await unlock(w);
  const attempts = [], t = await tracker('chrome', { async forward(message) {
    if (message.type === 'ingest') attempts.push(structuredClone(message));
    return w.send(message);
  } });
  await drainMessages();
  w.failWrites = true;
  for (let n = 1; n <= 80; n++) {
    t.input(); t.setNow(n * 1500); w.advance(1500);
    t.event('click', { isTrusted: true, target: t.button }); await t.tick(); await drainMessages();
  }
  w.failWrites = false;
  const cleared = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(cleared.ok, true);
  assert.deepEqual(w.data._receipts, ['preserved']); assert.equal(w.data._intentions.length, 1);
  const old = attempts[0];
  w = worker(w.data, 'chrome', w.now);
  await t.tick(); await drainMessages();
  assert.equal(w.data['2026-10-11'], undefined);
  assert.equal((await w.send(old)).generation, cleared.generation);
  t.input(); t.setNow(125000); w.advance(5000); await t.tick(); await drainMessages();
  assert.equal(w.data['2026-10-11'].x.consumeSec, 5);
  const fresh = attempts.at(-1); assert.equal(fresh.generation, cleared.generation);
  await w.send(fresh); assert.equal(w.data['2026-10-11'].x.consumeSec, 5);
  const nextClear = await w.send({ type: 'clear-history' }, popupSender);
  assert.notEqual(nextClear.generation, cleared.generation);
  await w.send({ ...fresh, id: 'new-id-old-generation' });
  assert.equal(w.data['2026-10-11'], undefined);
});

test('failed generation persistence never reports a successful history clear', async () => {
  const date = C.localDate(), w = activeWorker({ [date]: { x: { posts: 1 } } });
  await w.send({ type: 'snapshot' });
  w.failWrites = true;
  assert.equal((await w.send({ type: 'clear-history' }, popupSender)).ok, false);
  assert.equal(w.data[date].x.posts, 1);
  assert.equal(w.data._historyGeneration, undefined);
  w.failWrites = false;
  const cleared = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(cleared.ok, true); assert.equal(w.data[date], undefined);
  assert.equal((await w.send(packet('missing-generation'))).generation, cleared.generation);
  assert.equal(w.data[date], undefined);
});

test('failed history removal returns failure and its persisted generation still rejects old packets', async () => {
  const date = C.localDate(), w = activeWorker({ [date]: { x: { posts: 1 } } });
  await w.send({ type: 'snapshot' });
  w.failRemove = true;
  assert.equal((await w.send({ type: 'clear-history' }, popupSender)).ok, false);
  assert.equal(w.data[date].x.posts, 1);
  assert.equal(typeof w.data._historyGeneration, 'string');
  await w.send(packet('old-after-failed-clear'));
  assert.equal(w.data[date].x.consumeSec, undefined);
  w.failRemove = false;
  assert.equal((await w.send({ type: 'clear-history' }, popupSender)).ok, true);
  assert.equal(w.data[date], undefined);
});

test('a lost ingest acknowledgement retries the identical packet through the worker without doubling actions', async () => {
  const start = new Date(2026, 9, 11, 12).getTime(), w = worker({}, 'chrome', start - 60000);
  await unlock(w);
  let loseResponse = true;
  const attempts = [], t = await tracker('chrome', { async forward(message) {
    const result = await w.send(message);
    if (message.type === 'ingest') {
      attempts.push(structuredClone(message));
      if (loseResponse) throw new Error('Response lost');
    }
    return result;
  } });
  await drainMessages();
  t.input(); t.setNow(5000); w.advance(5000);
  t.event('click', { isTrusted: true, target: t.button });
  await drainMessages();
  assert.equal(w.data['2026-10-11'].x.posts, 1);
  loseResponse = false; await t.tick(); await drainMessages();
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(w.data['2026-10-11'].x.posts, 1);
  assert.equal(w.data['2026-10-11'].x.consumeSec, 5);
});
