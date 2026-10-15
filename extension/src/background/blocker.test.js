'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../../core/core.js');
const C3Sites = require('../../sites/index.js');
const MessageContracts = require('./message-contracts.js');
const { worker, gate, intent, popupSender } = require('../tests/background-harness.js');
const now = new Date(2026, 9, 11, 12).getTime();

function blocker(data = {}, browser = 'chrome', core = C) {
  const calls = [], failures = new Map(), counts = new Map(), alarms = {}, tabs = [];
  const session = { _accessInitialized: true };
  let rules = [];
  function call(type, value) {
    calls.push({ type, value: structuredClone(value) });
    const count = (counts.get(type) || 0) + 1;
    counts.set(type, count);
    const error = failures.get(type + ':' + count);
    if (error) throw error;
  }
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const api = {
    runtime: { getURL: file => 'chrome-extension://test-extension/' + file },
    storage: {
      session: {
        async get(key) { call('session.get', key); return { [key]: session[key] }; },
        async set(values) { call('session.set', values); Object.assign(session, structuredClone(values)); }
      },
      local: {
        async get(keys) {
          call('local.get', keys);
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => data[key] !== undefined).map(key => [key, structuredClone(data[key])]));
        },
        async set(values) { call('local.set', values); Object.assign(data, structuredClone(values)); }
      }
    },
    declarativeNetRequest: {
      async getSessionRules() { call('rules.get'); return structuredClone(rules); },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        call('rules.update', { removeRuleIds, addRules });
        rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      }
    },
    alarms: {
      async clear(name) { call('alarms.clear', name); delete alarms[name]; },
      async create(name, options) { call('alarms.create', { name, options }); alarms[name] = options; }
    },
    windows: { async getLastFocused() { call('windows.get'); return { focused: false }; } },
    tabs: {
      async query(query) { call('tabs.query', query); return structuredClone(tabs); },
      async update(id, changes) { call('tabs.update', { id, changes }); Object.assign(tabs.find(tab => tab.id === id), changes); }
    }
  };
  const context = vm.createContext({ [browser]: api, C3: core, C3Sites, MessageContracts, URL, Date: Clock });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'blocker.js'), 'utf8') + '\n globalThis.access = SiteAccess;', context);
  return {
    ...context.access, data, calls, alarms, tabs,
    get rules() { return structuredClone(rules); },
    failNext(type, error, offset = 1) { failures.set(type + ':' + ((counts.get(type) || 0) + offset), error); }
  };
}
const tracking = (site = 'x', enabled = false) => ({ type: 'tracking', site, enabled });
const writes = w => w.calls.filter(call => call.type === 'local.set').map(call => call.value);

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: tracking owns selection and gate changes without producing a background snapshot`, async () => {
    const settings = { trackedSites: ['linkedin', 'x', 'linkedin', 'retired'], accessMinutes: 12, siteOverrides: { x: { accessMinutes: 2 } } };
    const intentions = [{ site: 'x', reason: intent, requestedAt: now }];
    const date = C.localDate(new Date(now));
    const w = blocker({ settings, _intentions: intentions, [date]: { x: { posts: 1 } }, _access: { x: { remainingMs: 120000 } } }, browser);
    assert.deepEqual(structuredClone(await w.handle(tracking(), popupSender)), { ok: true });
    assert.deepEqual(w.data.settings, { ...C.DEFAULT_SETTINGS, ...settings, trackedSites: ['linkedin'] });
    assert.equal(w.data._access.x, undefined);
    assert.equal(w.alarms['access-x'], undefined);
    assert.deepEqual(w.data._intentions, intentions);
    assert.equal(w.data[date].x.posts, 1);
    assert.deepEqual(w.rules.map(rule => rule.id), [101, 104]);
    const settingWrite = w.calls.findIndex(call => call.type === 'local.set');
    const reconciliation = w.calls.findIndex(call => call.type === 'session.get');
    assert.ok(settingWrite < reconciliation);
    w.tabs.push({ id: 1, url: 'https://x.com/home' });
    assert.deepEqual(structuredClone(await w.handle(tracking('x', true), popupSender)), { ok: true });
    assert.deepEqual(w.data.settings.trackedSites, ['x', 'linkedin']);
    assert.equal(w.tabs[0].url, gate('x').url);
    assert.deepEqual(w.rules, []);
    assert.equal((await w.handle({ type: 'access-status' })).access.x.remainingMs, 0);
  });

  test(`${browser}: tracking authorization and validation precede all storage and gate effects`, async () => {
    const w = blocker({}, browser);
    for (const sender of [gate('x'), { ...popupSender, frameId: 1 }, { ...popupSender, url: popupSender.url + '?spoof=true' }, { url: 'https://evil.test/settings.html' }]) {
      await assert.rejects(w.handle(tracking(), sender), /Preferences must come from/);
    }
    for (const site of ['unknown', '__proto__', 'constructor', null]) await assert.rejects(w.handle(tracking(site), popupSender), /Choose a vetted website/);
    for (const enabled of ['false', 0, null, undefined]) await assert.rejects(w.handle({ type: 'tracking', site: 'x', enabled }, popupSender), /Choose a vetted website/);
    assert.deepEqual(w.calls, []);
    const sender = { url: 'chrome-extension://test-extension/settings.html', frameId: 0, tab: { id: 3 } };
    assert.equal((await w.handle(tracking(), sender)).ok, true);
  });
}

test('tracking accepts vetted integrations independently of whole-site gate support', async () => {
  const core = { ...C, SITES: [...C.SITES, { id: 'vetted' }] };
  const w = blocker({}, 'chrome', core);
  assert.equal((await w.handle(tracking('vetted', true), popupSender)).ok, true);
  assert.deepEqual(w.data.settings.trackedSites, ['x', 'linkedin', 'vetted']);
  assert.deepEqual(w.rules, []);
});

test('failed initial tracking persistence neither reconciles nor attempts rollback', async () => {
  const w = blocker();
  const failure = new Error('Initial write failed');
  w.failNext('local.set', failure);
  await assert.rejects(w.handle(tracking(), popupSender), error => error === failure);
  assert.equal(w.data.settings, undefined);
  assert.deepEqual(w.calls.map(call => call.type), ['local.get', 'local.set']);
});

test('failed tracking reconciliation restores exact prior preferences before retry and retains the original failure', async () => {
  for (const settings of [undefined, { trackedSites: ['x', 'linkedin'], accessMinutes: 12, custom: true }]) {
    const data = { _access: { x: { remainingMs: 240000 } } };
    if (settings) data.settings = structuredClone(settings);
    const w = blocker(data);
    const failure = new Error('First rule failure');
    w.failNext('rules.update', failure);
    w.failNext('rules.update', new Error('Retry rule failure'), 2);
    await assert.rejects(w.handle(tracking(), popupSender), error => error === failure);
    assert.deepEqual(w.data.settings, settings || C.DEFAULT_SETTINGS);
    assert.equal(w.data._access.x.remainingMs, 240000);
    assert.deepEqual(writes(w).map(change => change.settings), [{ ...C.DEFAULT_SETTINGS, ...settings, trackedSites: ['linkedin'] }, settings || C.DEFAULT_SETTINGS]);
    const updates = w.calls.flatMap((call, index) => call.type === 'rules.update' ? [index] : []);
    const rollback = w.calls.findIndex(call => call.type === 'local.set' && call.value.settings.trackedSites.includes('x'));
    assert.ok(updates[0] < rollback && rollback < updates[1]);
  }
});

test('a failed tracking rollback write supersedes reconciliation failure and prevents retry', async () => {
  const w = blocker();
  w.failNext('rules.update', new Error('Rule failure'));
  const rollback = new Error('Rollback unavailable');
  w.failNext('local.set', rollback, 2);
  await assert.rejects(w.handle(tracking(), popupSender), error => error === rollback);
  assert.equal(w.calls.filter(call => call.type === 'session.get').length, 1);
  assert.deepEqual(w.data.settings.trackedSites, ['linkedin']);
});

test('tracking rollback restores preferences but does not refund a session already discarded before a later failure', async () => {
  const w = blocker({ _access: { x: { remainingMs: 240000 } } });
  const failure = new Error('Tab query unavailable');
  w.failNext('tabs.query', failure);
  await assert.rejects(w.handle(tracking(), popupSender), error => error === failure);
  assert.deepEqual(w.data.settings, C.DEFAULT_SETTINGS);
  assert.equal(w.data._access.x, undefined);
  assert.deepEqual(w.rules, []);
});

test('ending access revokes rules before persistence, alarm clearing and tab redirects', async () => {
  const w = blocker({ _access: { x: { remainingMs: 240000 } } });
  w.tabs.push({ id: 1, url: 'https://x.com/home' });
  await w.reconcile();
  w.calls.length = 0;
  await w.handle({ type: 'access-end', site: 'x' }, popupSender);
  const revocation = w.calls.findIndex(call => call.type === 'rules.update');
  assert.deepEqual(w.calls.slice(revocation, revocation + 5).map(call => call.type), ['rules.update', 'local.set', 'alarms.clear', 'tabs.query', 'tabs.update']);
  assert.deepEqual(w.calls[revocation].value.removeRuleIds, [101, 104]);
  assert.equal(w.data._access.x, undefined);
  assert.equal(w.tabs[0].url, gate('x').url);
});

test('failed explicit revocation keeps persisted access and does not clear or redirect after failure', async () => {
  const w = blocker({ _access: { x: { remainingMs: 240000 } } });
  await w.reconcile();
  w.calls.length = 0;
  const failure = new Error('Revocation failed');
  w.failNext('rules.update', failure);
  await assert.rejects(w.handle({ type: 'access-end', site: 'x' }, popupSender), error => error === failure);
  assert.equal(w.data._access.x.remainingMs, 240000);
  assert.equal(w.calls.at(-1).type, 'rules.update');
  assert.deepEqual(writes(w), []);
});

test('invalid restored session dates cannot grant a daily refill or retain access', async () => {
  for (const date of ['not-a-date', '2026-02-30', '2026-13-01', '2026-10-1', 1, true, {}, [], null, '']) {
    const w = blocker({ _access: { x: { date, remainingMs: 120000, expiresAt: 0 } } });
    const state = (await w.handle({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 0, JSON.stringify(date));
    assert.equal(state.refilledAt, 0);
    assert.deepEqual(w.rules, []);
    assert.equal(w.alarms['access-midnight'], undefined);
    await assert.rejects(w.handle({ type: 'access-open', site: 'x' }, gate('x')), /Finish the waiting period/);
  }
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: malformed restored waiting deadlines cannot confirm access or prevent a fresh full wait`, async () => {
    const invalid = [0, -1, -Infinity, Infinity, NaN, '1', null, undefined, true, {}, []];
    const entries = [
      ...invalid.map(readyAt => ({ readyAt, requestExpiresAt: now + 600000 })),
      ...invalid.map(requestExpiresAt => ({ readyAt: now - 1, requestExpiresAt })),
      { readyAt: now - 1 },
      { requestExpiresAt: now + 600000 },
      { readyAt: now + 120000, requestExpiresAt: now + 60000 }
    ];
    for (const entry of entries) {
      const w = worker({ _access: { x: entry } }, browser, now);
      const result = await w.send({ type: 'access-status' });
      assert.equal(result.ok, true);
      assert.equal(result.access.x.readyAt, 0);
      assert.equal(result.access.x.requestExpiresAt, 0);
      assert.equal(w.errors.length, 0);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      assert.deepEqual(w.rules, []);
      const begin = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
      assert.equal(begin.ok, true);
      assert.equal(begin.access.x.readyAt, now + 60000);
      w.advance(59999);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      w.advance(1);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).access.x.remainingMs, 300000);
    }
  });
}

test('malformed restored access containers and entries fail closed without worker crashes', async () => {
  const malformed = [[], [1], 'saved', 1, true, null];
  const values = [
    ...malformed,
    Object.assign([], { x: { remainingMs: 120000 } }),
    ...malformed.map(x => ({ x })),
    { x: Object.assign([], { remainingMs: 120000 }) }
  ];
  for (const value of values) {
    const w = worker({ _access: value }, 'chrome', now);
    const result = await w.send({ type: 'access-status' });
    assert.equal(result.ok, true);
    assert.equal(result.access.x.remainingMs, 0);
    assert.deepEqual(w.rules, []);
    assert.equal(w.errors.length, 0);
    const begin = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    assert.equal(begin.ok, true);
    assert.equal(begin.access.x.readyAt, now + 60000);
    assert.equal(Array.isArray(w.data._access), false);
  }
});

test('invalid restored session numbers cannot revive access through legacy deadlines or daily refills', async () => {
  for (const field of ['remainingMs', 'expiresAt', 'refilledAt']) {
    for (const invalid of [-1, -Infinity, Infinity, NaN, '120000', true, null, undefined, {}, []]) {
      const entry = { date: '2026-10-10', remainingMs: 120000, expiresAt: now + 120000, refilledAt: now - 600000, [field]: invalid };
      const w = blocker({ _access: { x: entry } });
      const result = await w.handle({ type: 'access-status' });
      assert.equal(result.access.x.remainingMs, 0, field + ': ' + String(invalid));
      assert.equal(result.access.x.refilledAt, 0);
      assert.deepEqual(w.rules, []);
      assert.equal(w.alarms['access-midnight'], undefined);
    }
  }
});

const dashboardSender = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', frameId: 0 };

test('intention listing normalizes malformed history and preserves valid retired-site entries verbatim', async () => {
  const valid = [
    { site: 'x', reason: 'Old short intention', requestedAt: 0 },
    { site: 'retired-site', reason: '  Keep the original text  ', requestedAt: 1 },
    { site: 'older_site2', reason: intent, requestedAt: now }
  ];
  const invalid = [null, 1, true, 'entry', [], {}, { ...valid[0], site: null }, { ...valid[0], site: 'https://evil.test' }, { ...valid[0], reason: 1 }, { ...valid[0], reason: '' }, { ...valid[0], reason: '   ' }, { ...valid[0], reason: 'a'.repeat(281) }, { ...valid[0], requestedAt: -1 }, { ...valid[0], requestedAt: Infinity }, { ...valid[0], requestedAt: NaN }, { ...valid[0], requestedAt: '0' }];
  for (const history of [{}, 'history', 1, true, null, [valid[0], ...invalid, ...valid.slice(1)]]) {
    const data = { _intentions: structuredClone(history) };
    const w = blocker(data);
    const result = structuredClone(await w.handle({ type: 'access-history-list' }, dashboardSender));
    assert.deepEqual(result, { ok: true, intentions: Array.isArray(history) ? valid : [] });
    assert.deepEqual(data._intentions, history);
    assert.deepEqual(writes(w), []);
  }
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: appended intentions recover malformed history without rejecting an accepted wait`, async () => {
    const old = { site: 'retired-site', reason: 'Old reason', requestedAt: 0 };
    for (const history of [{}, 'history', 1, true, null, [null, old, { site: 'x', reason: intent, requestedAt: -1 }]]) {
      const w = worker({ settings: { intentionHistoryEnabled: true }, _intentions: history }, browser, now);
      const result = await w.send({ type: 'access-begin', site: 'x', reason: '  ' + intent + '  ' }, gate('x'));
      assert.equal(result.ok, true);
      assert.equal(result.access.x.readyAt, now + 60000);
      assert.equal(w.errors.length, 0);
      const expected = [...(Array.isArray(history) ? [old] : []), { site: 'x', reason: intent, requestedAt: now }];
      assert.deepEqual(w.data._intentions, expected);
      assert.deepEqual(await w.send({ type: 'access-history-list' }, dashboardSender), { ok: true, intentions: expected });
    }
  });
}

test('valid restored paused budgets and waits remain unchanged and exhausted sessions keep daily refill eligibility', async () => {
  const date = C.localDate(new Date(now));
  const entries = [
    { remainingMs: 120000, expiresAt: 0, refilledAt: 0, date },
    { readyAt: now + 30000, requestExpiresAt: now + 630000 },
    { date, refilledAt: now - 600000 }
  ];
  for (const entry of entries) {
    const data = { _access: { x: structuredClone(entry) } };
    const w = blocker(data);
    const state = (await w.handle({ type: 'access-status' })).access.x;
    assert.deepEqual(data._access.x, entry);
    assert.deepEqual(writes(w), []);
    assert.equal(state.remainingMs, entry.remainingMs || 0);
    assert.equal(state.readyAt, entry.readyAt || 0);
    assert.equal(Boolean(w.alarms['access-midnight']), Boolean(entry.date));
    if (entry.date && !entry.remainingMs) {
      const midnight = new Date(2026, 9, 12).getTime();
      const restarted = worker(structuredClone(data), 'chrome', midnight + 60000);
      const result = await restarted.send({ type: 'access-status' });
      assert.equal(result.access.x.remainingMs, 300000);
      assert.equal(result.access.x.refilledAt, midnight);
      assert.equal((await restarted.send({ type: 'access-status' })).access.x.remainingMs, 300000);
    }
  }
});

test('access validation delegates to shared domain policy without applying new-intention rules to saved history', async () => {
  const validations = { validLocalDate: [], validAccessMinutes: [], validIntention: [] }, core = { ...C };
  for (const policy of Object.keys(validations)) core[policy] = value => {
    validations[policy].push(value);
    return C[policy](value);
  };
  const w = blocker({ settings: { siteOverrides: { x: { accessMinutes: 241 } } }, _access: { x: { date: '2026-02-30', remainingMs: 120000 } }, _intentions: {} }, 'chrome', core);
  const state = (await w.handle({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 0);
  assert.equal(state.sessionMinutes, 5);
  assert.ok(validations.validLocalDate.includes('2026-02-30'));
  for (const reason of [null, 'short', ' '.repeat(20), 'a'.repeat(281)]) {
    validations.validIntention.length = 0;
    assert.deepEqual(structuredClone(await w.handle({ type: 'access-begin', site: 'x', reason }, gate('x'))), { ok: false, error: 'Write a specific intention of 20–280 characters.' });
    assert.deepEqual(validations.validIntention, [reason]);
  }
  validations.validIntention.length = 0;
  assert.equal((await w.handle({ type: 'access-begin', site: 'x', reason: intent }, gate('x'))).access.x.readyAt, now + 60000);
  assert.deepEqual(validations.validIntention, [intent]);
  assert.deepEqual(structuredClone(await w.handle({ type: 'access-history-list' }, dashboardSender)), { ok: true, intentions: [] });
  for (const minutes of [1, 240]) {
    validations.validAccessMinutes.length = 0;
    const result = await w.handle({ type: 'access-duration', site: 'x', minutes }, popupSender);
    assert.equal(result.access.x.sessionMinutes, minutes);
    assert.deepEqual(validations.validAccessMinutes, [minutes]);
  }
  validations.validAccessMinutes.length = 0;
  await assert.rejects(w.handle({ type: 'access-duration', site: 'x', minutes: 241 }, popupSender), /Choose a whole number from 1 to 240 minutes/);
  assert.deepEqual(validations.validAccessMinutes, [241]);
  assert.equal(w.data.settings.siteOverrides.x.accessMinutes, 240);
  for (const date of ['2024-02-29', '0099-01-01', '0000-02-29']) {
    validations.validLocalDate.length = 0;
    const legacy = blocker({ _access: { x: { date, remainingMs: 120000, expiresAt: 0 } } }, 'chrome', core);
    assert.equal((await legacy.handle({ type: 'access-status' })).access.x.remainingMs, 300000, date);
    assert.ok(validations.validLocalDate.includes(date));
  }
  const old = { site: 'retired-site', reason: 'Old reason', requestedAt: 0 };
  const history = blocker({ _intentions: [old] }, 'chrome', core);
  validations.validIntention.length = 0;
  assert.deepEqual(structuredClone(await history.handle({ type: 'access-history-list' }, dashboardSender)), { ok: true, intentions: [old] });
  assert.deepEqual(validations.validIntention, []);
  assert.deepEqual(history.data._intentions, [old]);
});

test('session messages still reconcile before rejecting authorization or an unknown command', async () => {
  const w = blocker();
  await assert.rejects(w.handle({ type: 'access-open', site: 'x' }, popupSender), /Access requests must come from/);
  assert.equal(w.calls[0].type, 'session.get');
  w.calls.length = 0;
  await assert.rejects(w.handle({ type: 'access-unknown', site: 'x' }, gate('x')), /Unknown access message/);
  assert.equal(w.calls[0].type, 'session.get');
  assert.deepEqual(w.calls.at(-1), { type: 'local.get', value: ['_access', 'settings', '_intentions'] });
});
