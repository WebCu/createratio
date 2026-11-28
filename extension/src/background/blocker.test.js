'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../../core/core.js');
const Sites = require('../../sites/index.js');
const MessageContracts = require('./message-contracts.js');
const { worker, gate, intent, popupSender, rulesFor } = require('../tests/background-harness.js');
const now = new Date(2026, 9, 11, 12).getTime();

function blocker(data = {}, browser = 'chrome', core = C, integrations = Sites) {
  const calls = [],
    failures = new Map(),
    counts = new Map(),
    alarms = {},
    tabs = [];
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
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const api = {
    runtime: { getURL: file => 'chrome-extension://test-extension/' + file },
    storage: {
      session: {
        async get(key) {
          call('session.get', key);
          return { [key]: session[key] };
        },
        async set(values) {
          call('session.set', values);
          Object.assign(session, structuredClone(values));
        }
      },
      local: {
        async get(keys) {
          call('local.get', keys);
          return Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys])
              .filter(key => data[key] !== undefined)
              .map(key => [key, structuredClone(data[key])])
          );
        },
        async set(values) {
          call('local.set', values);
          Object.assign(data, structuredClone(values));
        }
      }
    },
    declarativeNetRequest: {
      async getSessionRules() {
        call('rules.get');
        return structuredClone(rules);
      },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        call('rules.update', { removeRuleIds, addRules });
        rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      }
    },
    alarms: {
      async clear(name) {
        call('alarms.clear', name);
        delete alarms[name];
      },
      async create(name, options) {
        call('alarms.create', { name, options });
        alarms[name] = options;
      }
    },
    windows: {
      async getLastFocused() {
        call('windows.get');
        return { focused: false };
      }
    },
    tabs: {
      async query(query) {
        call('tabs.query', query);
        return structuredClone(tabs);
      },
      async update(id, changes) {
        call('tabs.update', { id, changes });
        Object.assign(
          tabs.find(tab => tab.id === id),
          changes
        );
      }
    }
  };
  const context = vm.createContext({
    [browser]: api,
    Core: core,
    Sites: integrations,
    MessageContracts,
    URL,
    Date: Clock
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'site-access.js'), 'utf8'), context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'blocker.js'), 'utf8') + '\n globalThis.access = SiteAccess;',
    context
  );
  return {
    ...context.access,
    data,
    calls,
    alarms,
    tabs,
    get rules() {
      return structuredClone(rules);
    },
    failNext(type, error, offset = 1) {
      failures.set(type + ':' + ((counts.get(type) || 0) + offset), error);
    }
  };
}
const tracking = (site = 'x', enabled = false) => ({ type: 'tracking', site, enabled });
const writes = w => w.calls.filter(call => call.type === 'local.set').map(call => call.value);

test('gate navigation is attempted even when the pre-navigation drain throws', async () => {
  const w = blocker({ _access: { x: { remainingMs: 0 } } });
  w.tabs.push({ id: 1, url: 'https://x.com/home' });
  w.setBeforeNavigate(async () => {
    throw new Error('Drain unavailable');
  });
  await assert.doesNotReject(w.reconcile());
  assert.equal(w.tabs[0].url, 'chrome-extension://test-extension/blocked.html?site=x');
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: tracking owns selection and gate changes without producing a background snapshot`, async () => {
    const settings = {
      trackedSites: ['linkedin', 'x', 'linkedin', 'retired'],
      accessMinutes: 12,
      siteOverrides: { x: { accessMinutes: 2 } }
    };
    const intentions = [{ site: 'x', reason: intent, requestedAt: now }];
    const date = C.localDate(new Date(now));
    const w = blocker(
      { settings, _intentions: intentions, [date]: { x: { posts: 1 } }, _access: { x: { remainingMs: 120000 } } },
      browser
    );
    assert.deepEqual(structuredClone(await w.handle(tracking(), popupSender)), { ok: true });
    assert.deepEqual(w.data.settings, { ...C.DEFAULT_SETTINGS, ...settings, trackedSites: ['linkedin'] });
    assert.equal(w.data._access.x, undefined);
    assert.equal(w.alarms['access-x'], undefined);
    assert.deepEqual(w.data._intentions, intentions);
    assert.equal(w.data[date].x.posts, 1);
    assert.deepEqual(
      rulesFor(w).map(rule => rule.id),
      [101, 104]
    );
    const settingWrite = w.calls.findIndex(call => call.type === 'local.set');
    const reconciliation = w.calls.findIndex(call => call.type === 'session.get');
    assert.ok(settingWrite < reconciliation);
    w.tabs.push({ id: 1, url: 'https://x.com/home' });
    assert.deepEqual(structuredClone(await w.handle(tracking('x', true), popupSender)), { ok: true });
    assert.deepEqual(w.data.settings.trackedSites, ['x', 'linkedin']);
    assert.equal(w.tabs[0].url, gate('x').url);
    assert.deepEqual(rulesFor(w), []);
    assert.equal((await w.handle({ type: 'access-status' })).access.x.remainingMs, 0);
  });

  test(`${browser}: tracking authorization and validation precede all storage and gate effects`, async () => {
    const w = blocker({}, browser);
    for (const sender of [
      gate('x'),
      { ...popupSender, frameId: 1 },
      { ...popupSender, url: popupSender.url + '?spoof=true' },
      { url: 'https://evil.test/settings.html' }
    ]) {
      await assert.rejects(w.handle(tracking(), sender), /Preferences must come from/);
    }
    for (const site of ['unknown', '__proto__', 'constructor', null])
      await assert.rejects(w.handle(tracking(site), popupSender), /Choose a vetted website/);
    for (const enabled of ['false', 0, null, undefined])
      await assert.rejects(w.handle({ type: 'tracking', site: 'x', enabled }, popupSender), /Choose a vetted website/);
    assert.deepEqual(w.calls, []);
    const sender = { url: 'chrome-extension://test-extension/settings.html', frameId: 0, tab: { id: 3 } };
    assert.equal((await w.handle(tracking(), sender)).ok, true);
  });
}

test('tracking accepts vetted integrations independently of whole-site gate support', async () => {
  const core = { ...C, SITES: [...C.SITES, { id: 'vetted' }] };
  const integrations = { ...Sites, validVettedSiteId: id => id === 'vetted' || Sites.validVettedSiteId(id) };
  const w = blocker({}, 'chrome', core, integrations);
  assert.equal((await w.handle(tracking('vetted', true), popupSender)).ok, true);
  assert.deepEqual(w.data.settings.trackedSites, [...C.DEFAULT_SETTINGS.trackedSites, 'vetted']);
  assert.deepEqual(rulesFor(w), []);
});

test('failed initial tracking persistence neither reconciles nor attempts rollback', async () => {
  const w = blocker();
  const failure = new Error('Initial write failed');
  w.failNext('local.set', failure);
  await assert.rejects(w.handle(tracking(), popupSender), error => error === failure);
  assert.equal(w.data.settings, undefined);
  assert.deepEqual(
    w.calls.map(call => call.type),
    ['local.get', 'local.set']
  );
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
    assert.deepEqual(
      writes(w).map(change => change.settings),
      [
        {
          ...C.DEFAULT_SETTINGS,
          ...settings,
          trackedSites: (settings?.trackedSites || C.DEFAULT_SETTINGS.trackedSites).filter(id => id !== 'x')
        },
        settings || C.DEFAULT_SETTINGS
      ]
    );
    const updates = w.calls.flatMap((call, index) => (call.type === 'rules.update' ? [index] : []));
    const rollback = w.calls.findIndex(
      call => call.type === 'local.set' && call.value.settings.trackedSites.includes('x')
    );
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
  assert.deepEqual(
    w.data.settings.trackedSites,
    C.DEFAULT_SETTINGS.trackedSites.filter(id => id !== 'x')
  );
});

test('tracking rollback restores preferences but does not refund a session already discarded before a later failure', async () => {
  const w = blocker({ _access: { x: { remainingMs: 240000 } } });
  const failure = new Error('Tab query unavailable');
  w.failNext('tabs.query', failure);
  await assert.rejects(w.handle(tracking(), popupSender), error => error === failure);
  assert.deepEqual(w.data.settings, C.DEFAULT_SETTINGS);
  assert.equal(w.data._access.x, undefined);
  assert.deepEqual(rulesFor(w), []);
});

test('ending access revokes rules before persistence, alarm clearing and tab redirects', async () => {
  const w = blocker({ _access: { x: { remainingMs: 240000 } } });
  w.tabs.push({ id: 1, url: 'https://x.com/home' });
  await w.reconcile();
  w.calls.length = 0;
  await w.handle({ type: 'access-end', site: 'x' }, popupSender);
  const revocation = w.calls.findIndex(call => call.type === 'rules.update');
  assert.deepEqual(
    w.calls.slice(revocation, revocation + 5).map(call => call.type),
    ['rules.update', 'local.set', 'alarms.clear', 'tabs.query', 'tabs.update']
  );
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
  for (const date of ['2026-02-30', 1]) {
    const w = blocker({ _access: { x: { date, remainingMs: 120000, expiresAt: 0 } } });
    const state = (await w.handle({ type: 'access-status' })).access.x;
    assert.equal(state.remainingMs, 0, JSON.stringify(date));
    assert.equal(state.refilledAt, null);
    assert.deepEqual(rulesFor(w), []);
    assert.equal(w.alarms['access-midnight'], undefined);
    await assert.rejects(w.handle({ type: 'access-open', site: 'x' }, gate('x')), /Finish the waiting period/);
  }
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: malformed restored waiting deadlines cannot confirm access or prevent a fresh full wait`, async () => {
    const entries = [{ readyAt: NaN }, { readyAt: now + C.ACCESS_LIMITS.maxMinutes * 60000 + 1 }];
    for (const entry of entries) {
      const w = worker({ _access: { x: entry } }, browser, now);
      const result = await w.send({ type: 'access-status' });
      assert.equal(result.ok, true);
      assert.equal(result.access.x.readyAt, null);
      assert.equal(w.errors.length, 0);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      assert.deepEqual(rulesFor(w), []);
      const begin = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
      assert.equal(begin.ok, true);
      assert.equal(begin.access.x.readyAt, now + 300000);
      w.advance(299999);
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
    assert.deepEqual(rulesFor(w), []);
    assert.equal(w.errors.length, 0);
    const begin = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    assert.equal(begin.ok, true);
    assert.equal(begin.access.x.readyAt, now + 300000);
    assert.equal(Array.isArray(w.data._access), false);
  }
});

test('invalid restored session numbers cannot revive access through legacy deadlines or daily refills', async () => {
  for (const field of ['remainingMs', 'expiresAt', 'refilledAt']) {
    for (const invalid of ['120000']) {
      const entry = {
        date: '2026-10-10',
        remainingMs: 120000,
        expiresAt: now + 120000,
        refilledAt: now - 600000,
        [field]: invalid
      };
      const w = blocker({ _access: { x: entry } });
      const result = await w.handle({ type: 'access-status' });
      assert.equal(result.access.x.remainingMs, 0, field + ': ' + String(invalid));
      assert.equal(result.access.x.refilledAt, null);
      assert.deepEqual(rulesFor(w), []);
      assert.equal(w.alarms['access-midnight'], undefined);
    }
  }
});

const dashboardSender = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', frameId: 0 };

test('intention listing skips entries it cannot show, without rewriting history, and keeps the rest verbatim', async () => {
  const valid = [
    { site: 'x', reason: 'Old short intention', requestedAt: 0 },
    { site: 'retired-site', reason: '  Keep the original text  ', requestedAt: 1 },
    { site: 'x', reason: 'a'.repeat(281), requestedAt: 2 },
    { site: 'older_site2', reason: intent, requestedAt: now }
  ];
  const invalid = [
    null,
    1,
    true,
    'entry',
    [],
    {},
    { ...valid[0], site: null },
    { ...valid[0], site: 'https://evil.test' },
    { ...valid[0], reason: 1 },
    { ...valid[0], reason: '' },
    { ...valid[0], reason: '   ' },
    { ...valid[0], requestedAt: -1 },
    { ...valid[0], requestedAt: Infinity },
    { ...valid[0], requestedAt: NaN },
    { ...valid[0], requestedAt: '0' }
  ];
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
  test(`${browser}: appended intentions keep all stored history and list what can be shown without rejecting an accepted wait`, async () => {
    const old = { site: 'retired-site', reason: 'An intention from a retired site', requestedAt: 0 },
      short = { site: 'x', reason: 'Old reason', requestedAt: 1 },
      unshowable = { site: 'x', reason: intent, requestedAt: -1 };
    for (const history of [{}, 'history', 1, true, null, [null, old, short, unshowable]]) {
      const w = worker({ settings: { intentionHistoryEnabled: true }, _intentions: history }, browser, now);
      const result = await w.send({ type: 'access-begin', site: 'x', reason: '  ' + intent + '  ' }, gate('x'));
      assert.equal(result.ok, true);
      assert.equal(result.access.x.readyAt, now + 300000);
      assert.equal(w.errors.length, 0);
      const added = { site: 'x', reason: intent, requestedAt: now };
      assert.deepEqual(w.data._intentions, [...(Array.isArray(history) ? history : []), added]);
      assert.deepEqual(await w.send({ type: 'access-history-list' }, dashboardSender), {
        ok: true,
        intentions: [...(Array.isArray(history) ? [old, short] : []), added]
      });
    }
  });
}

test('valid restored paused budgets and waits remain unchanged and exhausted sessions keep daily refill eligibility', async () => {
  const date = C.localDate(new Date(now));
  const entries = [
    { remainingMs: 120000, expiresAt: 0, refilledAt: 0, date },
    { readyAt: now + 30000 },
    { date, refilledAt: now - 600000 }
  ];
  for (const entry of entries) {
    const data = { _access: { x: structuredClone(entry) } };
    const w = blocker(data);
    const state = (await w.handle({ type: 'access-status' })).access.x;
    assert.deepEqual(data._access.x, entry);
    assert.deepEqual(writes(w), []);
    assert.equal(state.remainingMs, entry.remainingMs || 0);
    assert.equal(state.readyAt, entry.readyAt ?? null);
    assert.equal(state.refilledAt, entry.refilledAt || null);
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
  const validations = { validLocalDate: [], validAccessMinutes: [], intentionFromText: [], validIntention: [] },
    core = { ...C };
  for (const policy of Object.keys(validations))
    core[policy] = value => {
      validations[policy].push(value);
      return C[policy](value);
    };
  const w = blocker(
    {
      settings: { siteOverrides: { x: { accessMinutes: 241 } } },
      _access: { x: { date: '2026-02-30', remainingMs: 120000 } },
      _intentions: {}
    },
    'chrome',
    core
  );
  const state = (await w.handle({ type: 'access-status' })).access.x;
  assert.equal(state.remainingMs, 0);
  assert.equal(state.sessionMinutes, 5);
  assert.ok(validations.validLocalDate.includes('2026-02-30'));
  for (const reason of [null, 'short', ' '.repeat(20), 'a'.repeat(281)]) {
    validations.intentionFromText.length = 0;
    assert.deepEqual(structuredClone(await w.handle({ type: 'access-begin', site: 'x', reason }, gate('x'))), {
      ok: false,
      error: 'Write a specific intention of 20–280 characters.'
    });
    assert.deepEqual(validations.intentionFromText, [reason]);
  }
  validations.intentionFromText.length = 0;
  assert.equal(
    (await w.handle({ type: 'access-begin', site: 'x', reason: intent }, gate('x'))).access.x.readyAt,
    now + 300000
  );
  assert.deepEqual(validations.intentionFromText, [intent]);
  assert.deepEqual(structuredClone(await w.handle({ type: 'access-history-list' }, dashboardSender)), {
    ok: true,
    intentions: []
  });
  for (const minutes of [1, 240]) {
    validations.validAccessMinutes.length = 0;
    const result = await w.handle({ type: 'access-duration', site: 'x', minutes }, popupSender);
    assert.equal(result.access.x.sessionMinutes, minutes);
    assert.equal(validations.validAccessMinutes[0], minutes);
    assert.ok(validations.validAccessMinutes.slice(1).every(value => value === C.DEFAULT_SETTINGS.waitMinutes));
  }
  validations.validAccessMinutes.length = 0;
  await assert.rejects(
    w.handle({ type: 'access-duration', site: 'x', minutes: 241 }, popupSender),
    /Choose a whole number from 1 to 240 minutes/
  );
  assert.deepEqual(validations.validAccessMinutes, [241]);
  assert.equal(w.data.settings.siteOverrides.x.accessMinutes, 240);
  for (const date of ['2024-02-29', '0099-01-01', '0000-02-29']) {
    validations.validLocalDate.length = 0;
    const legacy = blocker({ _access: { x: { date, remainingMs: 120000, expiresAt: 0 } } }, 'chrome', core);
    assert.equal((await legacy.handle({ type: 'access-status' })).access.x.remainingMs, 300000, date);
    assert.ok(validations.validLocalDate.includes(date));
  }
  const kept = { site: 'retired-site', reason: 'An intention from a retired site', requestedAt: 0 },
    short = { site: 'retired-site', reason: 'Old reason', requestedAt: 1 };
  const history = blocker({ _intentions: [kept, short] }, 'chrome', core);
  validations.validIntention.length = 0;
  assert.deepEqual(structuredClone(await history.handle({ type: 'access-history-list' }, dashboardSender)), {
    ok: true,
    intentions: [kept, short]
  });
  assert.deepEqual(validations.validIntention, []);
  assert.deepEqual(history.data._intentions, [kept, short]);
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

test('lowering the intention wait preserves a pending request until its original deadline', async () => {
  const w = worker();
  const setting = { type: 'access-duration', preference: 'waitMinutes', minutes: 5 };
  assert.equal((await w.send(setting, popupSender)).ok, true);
  const begun = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  const { readyAt } = begun.access.x;
  assert.equal(readyAt, w.now + 300000);
  const changed = await w.send({ ...setting, minutes: 1 }, popupSender);
  assert.equal(changed.ok, true);
  assert.equal(changed.access.x.waitSeconds, 300);
  assert.equal(changed.access.x.readyAt, readyAt);
  assert.equal(w.data._access.x.readyAt, readyAt);
  w.advance(60000);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  w.advance(240000);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, true);
});

test('pending waits retain their own duration across setting changes and worker restart; new requests use the current setting', async () => {
  for (const [initial, updated] of [
    [1, 5],
    [5, 1]
  ]) {
    const w = worker({ settings: { waitMinutes: initial } });
    const begun = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    const { readyAt } = begun.access.x;
    assert.equal(w.data._access.x.waitMs, initial * 60000);
    w.advance(30000);
    const changed = await w.send(
      { type: 'access-duration', preference: 'waitMinutes', site: 'x', minutes: updated },
      popupSender
    );
    assert.equal(changed.access.x.waitSeconds, initial * 60);
    const restarted = worker(structuredClone(w.data), 'chrome', w.now);
    const restored = (await restarted.send({ type: 'access-status' })).access.x;
    assert.equal(restored.waitSeconds, initial * 60);
    assert.equal(restored.readyAt, readyAt);
    assert.equal((await restarted.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
    restarted.advance(86400000);
    const ready = (await restarted.send({ type: 'access-status' })).access.x;
    assert.equal(ready.readyAt, readyAt);
    assert.equal(ready.waitSeconds, initial * 60);
    assert.equal(ready.remainingMs, 0);
    assert.deepEqual(rulesFor(restarted), []);
    await restarted.send({ type: 'access-cancel', site: 'x' }, gate('x'));
    assert.equal((await restarted.send({ type: 'access-status' })).access.x.waitSeconds, updated * 60);
    const next = await restarted.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
    assert.equal(next.access.x.waitSeconds, updated * 60);
    assert.equal(next.access.x.readyAt, restarted.now + updated * 60000);
    restarted.advance(updated * 60000 + 600000);
    const completed = (await restarted.send({ type: 'access-status' })).access.x;
    assert.equal(completed.readyAt, next.access.x.readyAt);
    assert.equal(completed.waitSeconds, updated * 60);
    assert.equal(restarted.data._access.x.waitMs, updated * 60000);
  }
});

test('legacy or malformed stored wait durations retain the original 60-second wait without discarding a pending request', async () => {
  for (const waitMs of [undefined, '60000']) {
    const entry = { readyAt: now + 30000, ...(waitMs === undefined ? {} : { waitMs }) };
    const w = worker({ settings: { waitMinutes: 2 }, _access: { x: entry } }, 'chrome', now);
    const result = (await w.send({ type: 'access-status' })).access.x;
    assert.equal(result.readyAt, entry.readyAt);
    assert.equal(result.waitSeconds, 60);
    assert.deepEqual(w.errors, []);
  }
  const w = worker({ settings: { waitMinutes: 2 }, _access: { x: { waitMs: 60000 } } }, 'chrome', now);
  assert.equal((await w.send({ type: 'access-status' })).access.x.waitSeconds, 120);
});

test('restored waits cannot have more time remaining than their original validated duration', async () => {
  for (const browser of ['chrome', 'browser']) {
    for (const waitMs of [300000, '60000']) {
      const duration = C.validAccessMinutes(waitMs / 60000) && typeof waitMs === 'number' ? waitMs : 60000;
      const entry = { readyAt: now + duration + 1, ...(waitMs === undefined ? {} : { waitMs }) };
      const w = worker({ _access: { x: entry } }, browser, now);
      const rejected = (await w.send({ type: 'access-status' })).access.x;
      assert.equal(rejected.readyAt, null);
      assert.equal(w.data._access.x?.waitMs, undefined);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      const boundary = worker({ _access: { x: { ...entry, readyAt: now + duration } } }, browser, now);
      const pending = (await boundary.send({ type: 'access-status' })).access.x;
      assert.equal(pending.readyAt, now + duration);
      assert.equal(pending.waitSeconds, duration / 1000);
      const returned = worker(structuredClone(boundary.data), browser, now + 86400000);
      const ready = (await returned.send({ type: 'access-status' })).access.x;
      assert.equal(ready.readyAt, pending.readyAt);
      assert.equal(ready.waitSeconds, duration / 1000);
      assert.equal(ready.remainingMs, 0);
      assert.deepEqual(rulesFor(returned), []);
      assert.equal((await returned.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, true);
    }
  }
});

test('saved intention waits control deadlines without changing session duration', async () => {
  const w = worker();
  const setting = { type: 'access-duration', preference: 'waitMinutes', minutes: 5 };
  assert.equal((await w.send(setting, popupSender)).ok, true);
  assert.equal((await w.send({ ...setting, site: 'x', minutes: 2 }, popupSender)).ok, true);
  const result = await w.send({ type: 'access-begin', site: 'x', reason: intent }, gate('x'));
  assert.equal(result.access.x.waitSeconds, 120);
  assert.equal(result.access.x.readyAt, w.now + 120000);
  assert.equal(result.access.linkedin.waitSeconds, 300);
  assert.equal(result.access.x.sessionMinutes, 5);
  w.advance(60000);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
  w.advance(60000);
  assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, true);
  for (const minutes of [undefined, null, 0, 241, '2'])
    assert.equal((await w.send({ ...setting, minutes }, popupSender)).ok, false);
  assert.equal((await w.send({ ...setting, preference: 'unknown' }, popupSender)).ok, false);
  assert.equal((await w.send(setting, gate('x'))).ok, false);
});
