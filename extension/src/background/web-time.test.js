'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const C3 = require('../../core/core.js');
const WebTime = require('./web-time.js');

function harness(data = {}) {
  let now = new Date(2026, 9, 11, 12).getTime(), queue = Promise.resolve(), timer = null;
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
  const state = { allowed: true, idle: 'active', focused: true, tab: { id: 1, url: 'https://www.example.com/private?secret=1' }, queries: 0 };
  const alarms = {};
  const api = {
    permissions: { async contains() { return state.allowed; }, onRemoved: event() },
    idle: { setDetectionInterval(seconds) { assert.equal(seconds, 30); }, async queryState(seconds) { assert.equal(seconds, 30); return state.idle; }, onStateChanged: event() },
    windows: { async getLastFocused() { state.queries++; return { id: 1, focused: state.focused, type: 'normal' }; }, onFocusChanged: event() },
    tabs: { async query(options) { assert.deepEqual(structuredClone(options), { active: true, windowId: 1 }); return state.tab ? [state.tab] : []; }, onActivated: event(), onUpdated: event(), onRemoved: event() },
    storage: { local: { async get(keys) { return Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; } } },
    alarms: { async create(key, options) { alarms[key] = options; }, async clear(key) { delete alarms[key]; } }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Date: Clock, URL, TextEncoder, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'history.js'), 'utf8'), context);
  const history = context.ActivityHistory.create(api.storage.local, C3);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web-time.js'), 'utf8'), context);
  function serialize(task) { const next = queue.then(task); queue = next.catch(() => {}); return next; }
  const tracker = context.WebTime.create(api, serialize, C3, history, { setInterval(fn, ms) { assert.equal(ms, 5000); timer = fn; return 1; }, clearInterval() { timer = null; } });
  return { data, api, state, tracker, alarms, advance(ms) { now += ms; }, setTime(value) { now = value; }, async tick() { return serialize(() => tracker.tick()); }, async drain() { return serialize(() => {}); }, get timer() { return timer; } };
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
  assert.ok(h.timer); assert.equal(h.alarms['website-time'].periodInMinutes, 1);
  h.advance(5000); await h.tick();
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  assert.equal(JSON.stringify(h.data).includes('secret'), false);
  assert.equal(JSON.stringify(h.data).includes('/private'), false);
});

test('switching tabs and navigation attribute intervals to the previous domain', async () => {
  const h = harness(); await h.tracker.setEnabled(true);
  h.advance(2000); h.state.tab.url = 'https://other.test/feed'; h.api.tabs.onActivated.emit(); await h.drain();
  h.advance(3000); h.state.tab.url = 'https://third.test/messages'; h.api.tabs.onUpdated.emit(1, { url: h.state.tab.url }); await h.drain();
  h.advance(5000); await h.tick();
  assert.deepEqual(h.data['_websiteTime:2026-10-11'], { 'example.com': 2, 'other.test': 3, 'third.test': 5 });
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
  h.advance(60000); await h.tick(); assert.equal(h.data._websiteTime, undefined);
  h.advance(-10000); await h.tick(); assert.equal(h.data._websiteTime, undefined);
  h.advance(5000); await h.tick(); assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
  const restarted = harness(h.data); restarted.advance(3600000); await restarted.tracker.start();
  restarted.advance(5000); await restarted.tick(); assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 10);
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

test('concurrent ticks share the serialized writer without double counting', async () => {
  const h = harness(); await h.tracker.setEnabled(true); h.advance(5000);
  await Promise.all([h.tick(), h.tick(), h.tick()]);
  assert.equal(h.data['_websiteTime:2026-10-11']['example.com'], 5);
});
