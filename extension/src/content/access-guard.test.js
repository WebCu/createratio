'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { accessState } = require('../tests/ui-harness.js');

function guard(host = 'x.com', browser = 'chrome', options = {}) {
  let remainingMs = 300000, enabled = true, goalAllowed = false, timer, broken = false, calls = 0, focused = true;
  const events = {}, redirects = [], runtimeListeners = new Set();
  const listen = (name, fn) => { events[name] = fn; };
  const document = { hidden: false, hasFocus: () => focused, addEventListener: listen, removeEventListener(name) { delete events[name]; } };
  const context = vm.createContext({ URL, Date, document, addEventListener: listen, removeEventListener(name) { delete events[name]; }, C3Sites: require('../../sites/index.js'),
    location: { hostname: host, href: 'https://' + host + '/', replace: url => redirects.push(url) },
    setTimeout(fn, delay) { timer = { fn, delay }; return 1; }, clearTimeout() { timer = undefined; },
    [browser]: { runtime: { id: 'extension', onMessage: { addListener(fn) { runtimeListeners.add(fn); }, removeListener(fn) { runtimeListeners.delete(fn); } }, getURL: file => 'chrome-extension://extension/' + file, async sendMessage(message) {
      assert.equal(message.type, 'access-status'); calls++;
      if (broken) throw new Error('Worker unavailable');
      if (Object.hasOwn(options, 'reply')) return options.reply;
      return { ok: true, access: { x: accessState('x', { remainingMs, enabled, goalAllowed }), linkedin: accessState('linkedin', { remainingMs, enabled, goalAllowed }) } };
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/messages.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'lifecycle.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'access-guard.js'), 'utf8'), context);
  return { redirects, document, get calls() { return calls; }, get timer() { return timer; }, set remainingMs(value) { remainingMs = value; }, set goalAllowed(value) { goalAllowed = value; }, set enabled(value) { enabled = value; }, set focused(value) { focused = value; }, set broken(value) { broken = value; }, event: name => events[name](), flush: () => new Promise(resolve => setImmediate(resolve)) };
}
test('guard fails closed on missing access, malformed success and untyped permission flags', async () => {
  for (const reply of [undefined, { ok: 'true', access: { x: accessState('x', { remainingMs: 60000 }) } }, { ok: true }, { ok: true, access: {} }, { ok: true, access: { x: accessState('x', { goalAllowed: 'true' }) } }, { ok: true, access: { x: accessState('x', { remainingMs: '60000' }) } }]) {
    const g = guard('x.com', 'chrome', { reply }); await g.flush();
    assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=x']);
    assert.equal(g.timer, undefined);
  }
});
test('guard fails closed on unsafe access homes without requiring core to be loaded', async () => {
  for (const home of ['https://[/', 'https://evil.test/', 'https://www.linkedin.com/feed/', 'https://user@x.com/home', 'https://x.com/home?redirect=https://evil.test/']) {
    for (const browser of ['chrome', 'browser']) {
      const g = guard('x.com', browser, { reply: { ok: true, access: { x: accessState('x', { enabled: false, home }) } } });
      await g.flush();
      assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=x']);
      assert.equal(g.timer, undefined);
    }
  }
});
test('guard sleeps until the authoritative expiry and blocks at exhaustion', async () => {
  const g = guard(); await g.flush();
  assert.equal(g.timer.delay, 300000); assert.deepEqual(g.redirects, []);
  g.remainingMs = 0; await g.timer.fn();
  assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=x']);
});
test('Off allows free access with no budget; switching On restores the gate', async () => {
  const g = guard(); await g.flush(); g.enabled = false; g.remainingMs = 0; await g.event('focus');
  assert.deepEqual(g.redirects, []); assert.equal(g.timer, undefined);
  g.enabled = true; await g.event('focus'); assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=x']);
});
test('goal-based access permits browsing without polling and checks revocation on return', async () => {
  const g = guard(); await g.flush(); g.remainingMs = 0; g.goalAllowed = true;
  await g.event('focus'); assert.deepEqual(g.redirects, []); assert.equal(g.timer, undefined);
  g.goalAllowed = false; await g.event('focus');
  assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=x']);
});

test('a stale page timer cannot expire a paused session', async () => {
  const g = guard(); await g.flush();
  const stale = g.timer.fn;
  g.focused = false; await g.event('blur');
  assert.equal(g.timer, undefined);
  await stale();
  assert.deepEqual(g.redirects, []);
  g.focused = true; await g.event('focus');
  assert.equal(g.timer.delay, 300000);
});
test('guard checks restored pages, focus and visibility for exhausted budgets', async () => {
  for (const event of ['pageshow', 'focus', 'visibilitychange']) {
    const g = guard('www.linkedin.com', 'browser'); await g.flush();
    g.remainingMs = 0; await g.event(event); await g.flush();
    assert.deepEqual(g.redirects, ['chrome-extension://extension/blocked.html?site=linkedin']);
  }
});
test('guard fails closed when the worker is unavailable and recognizes X aliases', async () => {
  for (const host of ['mobile.x.com', 'twitter.com', 'www.twitter.com']) {
    const g = guard(host); await g.flush(); g.broken = true; await g.event('focus');
    assert.equal(g.redirects[0], 'chrome-extension://extension/blocked.html?site=x');
  }
});
test('guard does nothing on unknown hosts rather than defaulting to another gate', async () => {
  for (const host of ['example.test', 'x.com.evil.test', 'notlinkedin.com']) {
    const g = guard(host); await g.flush();
    assert.equal(g.calls, 0); assert.equal(g.timer, undefined); assert.deepEqual(g.redirects, []);
  }
});

test('hidden pages stop polling and concurrent checks are coalesced', async () => {
  const g = guard(); await g.flush();
  g.document.hidden = true; await g.event('visibilitychange');
  assert.equal(g.timer, undefined); assert.deepEqual(g.redirects, []);
  g.event('focus'); g.event('pageshow'); await g.flush(); assert.equal(g.calls, 3);
});
