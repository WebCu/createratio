'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Core = require('../../core/core.js');
const WebTime = require('./web-time.js');

function harness(data = {}, session = {}) {
  let now = new Date(2026, 9, 11, 12).getTime(), queue = Promise.resolve(), timer = null;
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
  const state = { allowed: true, idle: 'active', focused: true, tab: { id: 1, url: 'https://www.example.com/private?secret=1' }, queries: 0 };
  const alarms = {};
  const api = {
    permissions: { async contains() { return state.allowed; }, onRemoved: event() },
    idle: { setDetectionInterval(seconds) { assert.equal(seconds, 30); }, async queryState(seconds) { assert.equal(seconds, 30); return state.idle; }, onStateChanged: event() },
    windows: { async getLastFocused() { state.queries++; return { id: 1, focused: state.focused, type: 'normal' }; }, onFocusChanged: event() },
    tabs: { async query(options) { assert.deepEqual(structuredClone(options), { active: true, windowId: 1 }); return state.tab ? [state.tab] : []; }, onActivated: event(), onUpdated: event(), onRemoved: event() },
    storage: { session: { async get(key) { return { [key]: structuredClone(session[key]) }; }, async set(values) { Object.assign(session, structuredClone(values)); } }, local: { async get(keys) { return Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; } } },
    alarms: { async create(key, options) { alarms[key] = options; }, async clear(key) { delete alarms[key]; } }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Date: Clock, URL, TextEncoder, console, crypto });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'history.js'), 'utf8'), context);
  const history = context.ActivityHistory.create(api.storage.local, Core);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web-time.js'), 'utf8'), context);
  function serialize(task) { const next = queue.then(task); queue = next.catch(() => {}); return next; }
  const tracker = context.WebTime.create(api, serialize, Core, history, { setInterval(fn, ms) { assert.equal(ms, 5000); timer = fn; return 1; }, clearInterval() { timer = null; } });
  return { data, session, api, state, tracker, history, alarms, advance(ms) { now += ms; }, setTime(value) { now = value; }, async tick(alarm) { return serialize(() => tracker.tick(alarm)); }, async drain() { return serialize(() => {}); }, get timer() { return timer; } };
}

test('domain-only HTTP/S identifiers, duration, range totals, ordering and CSV', () => {
  assert.equal(WebTime.domainForURL('https://www.example.com/private?q=secret#draft'), 'example.com');
  assert.equal(WebTime.domainForURL('http://docs.example.com/a'), 'docs.example.com');
  for (const url of ['chrome://settings', 'about:blank', 'file:///secret', 'chrome-extension://id/popup.html', 'not a URL']) assert.equal(WebTime.domainForURL(url), null);
  const days = { '2026-10-11': { 'x.com': 60, 'example.com': 120 }, '2026-10-12': { 'x.com': 90 }, metadata: { 'x.com': 9999 } };
  assert.deepEqual(WebTime.summarize(days), [['x.com', 150], ['example.com', 120]]);
  assert.deepEqual(WebTime.summarize(days, ['2026-10-11']), [['example.com', 120], ['x.com', 60]]);
  assert.equal(WebTime.duration(0), '0s'); assert.equal(WebTime.duration(65), '1m 5s'); assert.equal(WebTime.duration(3665), '1h 1m');
  assert.equal(WebTime.csv({ '2026-10-11': { 'example.com': 60 } }), 'date,domain,seconds\r\n2026-10-11,"example.com",60.000\r\n');
  assert.deepEqual(WebTime.summarize({ '2026-10-11': { invalid: -1, nan: NaN } }), []);
});

test('website shares round to whole percentages that add up to 100', () => {
  assert.deepEqual(WebTime.shares([['a', 1], ['b', 1], ['c', 1]]), [34, 33, 33]);
  assert.deepEqual(WebTime.shares([['a', 4], ['b', 3], ['c', 3], ['d', 3], ['e', 3], ['f', 3], ['g', 3]]), [18, 14, 14, 14, 14, 13, 13]);
  assert.deepEqual(WebTime.shares([['a', 2], ['b', 1]]), [67, 33]);
  assert.deepEqual(WebTime.shares([['a', 120]]), [100]);
  assert.deepEqual(WebTime.shares([]), []);
});

test('website CSV treats formula-like domains as text without changing ordinary domains', () => {
  const domains = ['=1+1', '+1', '-example.test', '@example.test', '\t=1+1', '\r=1+1', '\n=1+1'];
  const day = Object.fromEntries(domains.map(domain => [domain, 5]));
  const csv = WebTime.csv({ '2026-10-11': day });
  for (const domain of domains) assert.ok(csv.includes(`"'${domain}",5.000`), domain);
  assert.equal(WebTime.csv({ '2026-10-11': { 'example.com': 5 } }), 'date,domain,seconds\r\n2026-10-11,"example.com",5.000\r\n');
  assert.equal(WebTime.domainForURL('https://=1+1/'), '=1+1', 'the actual URL parser accepts a formula-like hostname');
});

test('off by default: no tab inspection, timer or website records', async () => {
  const h = harness(); await h.tracker.start(); h.advance(5000); await h.tick();
  assert.equal(h.state.queries, 0); assert.equal(h.timer, null); assert.deepEqual(h.data, {});
});

test('permission required; starts from opt-in without importing browser history', async () => {
  const h = harness(); await h.tracker.start(); h.state.allowed = false;
  await assert.rejects(h.tracker.setEnabled(true), /Allow the browser permissions/);
  assert.deepEqual(h.data, {});
  h.advance(60000); h.state.allowed = true; await h.tracker.setEnabled(true);
  assert.equal(h.timer, null); assert.equal(h.alarms['website-time'].periodInMinutes, 1);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  assert.equal(JSON.stringify(h.data).includes('secret'), false);
  assert.equal(JSON.stringify(h.data).includes('/private'), false);
});

test('enabled Website time permits worker dormancy and credits a normal alarm interval', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  assert.equal(h.timer, null, 'tracking must not keep the worker alive with a five-second timer');
  h.advance(60000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 60);
});

test('switching tabs and navigation attribute intervals to the previous domain', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  h.advance(2000); h.state.tab.url = 'https://other.test/feed'; h.api.tabs.onActivated.emit(); await h.drain();
  h.advance(3000); h.state.tab.url = 'https://third.test/messages'; h.api.tabs.onUpdated.emit(1, { url: h.state.tab.url }); await h.drain();
  h.advance(5000); await h.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 2, 'other.test': 3, 'third.test': 5 });
});

test('failed website time writes preserve the interval for the next tick', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  assert.equal(h.data['_websiteTime:2026-10-11'], undefined);
  h.api.storage.local.set = set;
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']?.['example.com'], 10);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 15);
});

test('failed website time writes preserve tab boundaries across worker replacement', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); h.state.tab.url = 'https://other.test/';
  await assert.rejects(h.tick(), /Storage unavailable/);
  h.api.storage.local.set = set;
  const replacement = harness(h.data, h.session); replacement.advance(10000);
  replacement.state.tab.url = 'https://other.test/';
  await replacement.tracker.start(); await replacement.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5, 'other.test': 5 });
  replacement.advance(5000); await replacement.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5, 'other.test': 10 });
});

for (const inactive of ['idle', 'unfocused']) {
  test(`failed website time writes do not backfill ${inactive} time`, async () => {
    const h = harness(); await h.tracker.setEnabled(true);
    const set = h.api.storage.local.set;
    h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
    h.advance(5000);
    if (inactive === 'idle') h.state.idle = 'idle';
    else h.state.focused = false;
    await assert.rejects(h.tick(), /Storage unavailable/);
    h.api.storage.local.set = set;
    h.advance(5000); await h.tick();
    h.advance(5000); await h.tick();
    assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5 });
  });
}

test('website time pauses at the pending limit and resumes without backfilling', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  for (let i = 0; i < 105; i++) {
    h.advance(1000); await assert.rejects(h.tick(), /Storage unavailable/);
  }
  assert.equal(h.session._websiteTimePending.length, 100);
  assert.equal(h.session._websiteTimeSample, null);
  h.api.storage.local.set = set;
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 100);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 105);
  assert.deepEqual(h.session._websiteTimePending, []);
});

test('website time retries only unsaved segments after a partial recovery', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); h.state.tab.url = 'https://other.test/';
  await assert.rejects(h.tick(), /Storage unavailable/);
  let writes = 0;
  h.api.storage.local.set = async values => {
    if (++writes === 2) throw new Error('Storage unavailable');
    await set(values);
  };
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5 });
  h.api.storage.local.set = set;
  h.advance(5000); await h.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5, 'other.test': 10 });
  h.advance(5000); await h.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 5, 'other.test': 15 });
});

test('failed disable checkpoints partial website time recovery before worker replacement', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  let writes = 0;
  h.api.storage.local.set = async values => {
    if (++writes === 2) throw new Error('Storage unavailable');
    await set(values);
  };
  await assert.rejects(h.tracker.setEnabled(false), /Storage unavailable/);
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  h.api.storage.local.set = set;
  const replacement = harness(h.data, h.session); replacement.advance(10000);
  await replacement.tracker.start(); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 10);
  replacement.advance(5000); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 15);
});

for (const pending of [false, true]) {
  test(`website time replay after a failed checkpoint does not duplicate a restored ${pending ? 'pending queue' : 'sample'}`, async () => {
    const h = harness(); await h.tracker.setEnabled(true);
    if (pending) {
      const set = h.api.storage.local.set;
      h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
      h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
      h.api.storage.local.set = set;
    }
    h.api.storage.session.set = async () => { throw new Error('Checkpoint unavailable'); };
    h.advance(5000); await assert.rejects(h.tick(), /Checkpoint unavailable/);
    const saved = h.data['_websiteTime:2026-10-11']['example.com'];
    const replacement = harness(h.data, h.session); replacement.advance(15000);
    await replacement.tracker.start(); await replacement.tick();
    assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], saved);
    replacement.advance(5000); await replacement.tick();
    assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], saved + 5);
  });
}

test('history clear resets website samples and pending entries and permits fresh time', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  h.api.storage.local.set = set;
  await h.history.clear('after-clear');
  h.state.focused = false;
  await h.tracker.start(true);
  const replacement = harness(h.data, h.session); replacement.advance(10000);
  await replacement.tracker.start(); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11'], undefined);
  replacement.advance(5000); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  await replacement.history.clear('another-clear'); await replacement.tracker.start(true);
  replacement.advance(5000); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
});

for (const generation of [null, 'stable']) {
  test(`website receipt rollover preserves queued intervals across restart with generation ${generation}`, async () => {
    const data = { _websiteTimeReceipts: Array.from({ length: Core.DELIVERY_LIMITS.receiptLimit }, (_, i) => 'receipt-' + i) };
    if (generation !== null) data._historyGeneration = generation;
    const h = harness(data); await h.tracker.setEnabled(true);
    const set = h.api.storage.local.set;
    h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
    h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
    h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
    h.api.storage.local.set = set;
    const replacement = harness(h.data, h.session); replacement.advance(15000);
    await replacement.tracker.start(); await replacement.tick();
    assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 15);
    assert.equal(h.data._historyGeneration ?? null, generation);
    assert.equal(h.data._websiteTimeReceipts.length, Core.DELIVERY_LIMITS.receiptLimit);
    replacement.advance(5000); await replacement.tick();
    assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 20);
  });
}

test('repeated checkpoint failures cannot evict replayable website receipts', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  h.api.storage.session.set = async () => { throw new Error('Checkpoint unavailable'); };
  for (let i = 0; i < Core.DELIVERY_LIMITS.receiptLimit + 2; i++) {
    h.advance(1); await assert.rejects(h.tick(), /Checkpoint unavailable/);
  }
  const saved = h.data['_websiteTime:2026-10-11']['example.com'];
  const replacement = harness(h.data, h.session); replacement.advance(1000);
  await replacement.tracker.start(); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], saved);
});

test('failed reset checkpoint cannot restore cleared website samples or pending time', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  h.api.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  h.advance(5000); await assert.rejects(h.tick(), /Storage unavailable/);
  h.api.storage.local.set = set;
  await h.history.clear('after-clear');
  h.api.storage.session.set = async () => { throw new Error('Checkpoint unavailable'); };
  await assert.rejects(h.tracker.start(true), /Checkpoint unavailable/);
  const replacement = harness(h.data, h.session); replacement.advance(10000);
  await replacement.tracker.start(); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11'], undefined);
  replacement.advance(5000); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
});

test('unfocused windows, idle/locked time, private tabs and browser pages never accrue', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  h.advance(2000); h.state.focused = false; h.api.windows.onFocusChanged.emit(-1); await h.drain();
  h.advance(5000); await h.tick();
  h.state.focused = true; h.state.idle = 'idle'; await h.tick(); h.advance(5000); await h.tick();
  h.state.idle = 'locked'; await h.tick(); h.advance(5000); await h.tick();
  h.state.idle = 'active'; h.state.tab.incognito = true; await h.tick(); h.advance(5000); await h.tick();
  h.state.tab = { url: 'chrome://settings' }; await h.tick(); h.advance(5000); await h.tick();
  h.state.tab = null; await h.tick(); h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 2);
  h.state.tab = { url: 'https://example.com/' }; await h.tick(); h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 7);
});

test('sleep, backward clock changes and service-worker restarts do not backfill', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  h.advance(120000); await h.tick(); assert.equal(h.data['_websiteTime:2026-10-11'], undefined);
  h.advance(-10000); await h.tick(); assert.equal(h.data['_websiteTime:2026-10-11'], undefined);
  h.advance(5000); await h.tick(); assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  const restarted = harness(h.data); restarted.advance(3600000); await restarted.tracker.start();
  restarted.advance(5000); await restarted.tick(); assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 10);
});

test('session checkpoints survive worker replacement but late alarms discard suspended time', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  const replacement = harness(h.data, h.session); replacement.advance(60000);
  await replacement.tracker.start(); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 60);
  replacement.advance(60000);
  await replacement.tick({ scheduledTime: new Date(2026, 9, 11, 12, 1, 30).getTime() });
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 60);
  replacement.advance(5000); await replacement.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 65);
});

test('midnight splits website time across local dates', async () => {
  const h = harness(); h.setTime(new Date(2026, 9, 11, 23, 59, 58).getTime()); await h.tracker.setEnabled(true);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 2);
  assert.equal(h.data['_websiteTime:2026-10-12']['example.com'], 3);
});

test('disable keeps totals, stops timer; permission revocation stops tracking', async () => {
  const h = harness(); await h.tracker.setEnabled(true); h.advance(2000); await h.tracker.setEnabled(false);
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 2); assert.equal(h.timer, null);
  h.advance(5000); await h.tick(); assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 2);
  await h.tracker.setEnabled(true); h.state.allowed = false; h.api.permissions.onRemoved.emit(); await h.drain();
  assert.equal(h.tracker.enabled, false); assert.equal(h.data._websiteTimeEnabled, false); assert.equal(h.timer, null);
  assert.equal(h.alarms['website-time'], undefined);
});

test('a failed Website time disable save keeps recording without a worker restart', async (t) => {
  const h = harness(); await h.tracker.setEnabled(true);
  const set = h.api.storage.local.set;
  t.mock.method(h.api.storage.local, 'set', async values => {
    if (values._websiteTimeEnabled === false) throw new Error('Preference write failed');
    return set(values);
  });

  h.advance(2000);
  await assert.rejects(h.tracker.setEnabled(false), /Preference write failed/);
  assert.equal(h.data._websiteTimeEnabled, true);
  assert.equal(h.tracker.enabled, true);
  assert.ok(h.alarms['website-time']);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 7);
});

test('a failed Website time enable save does not start tracking', async (t) => {
  const h = harness(); await h.tracker.start();
  t.mock.method(h.api.storage.local, 'set', async () => { throw new Error('Preference write failed'); });

  await assert.rejects(h.tracker.setEnabled(true), /Preference write failed/);
  assert.equal(h.data._websiteTimeEnabled, undefined);
  assert.equal(h.tracker.enabled, false);
  assert.equal(h.alarms['website-time'], undefined);
  h.advance(5000); await h.tick();
  assert.equal(h.state.queries, 0);
});

test('concurrent ticks share the serialized writer without double counting', async () => {
  const h = harness(); await h.tracker.setEnabled(true); h.advance(5000);
  await Promise.all([h.tick(), h.tick(), h.tick()]);
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
});
