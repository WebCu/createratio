'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Updates = require('./updates.js');

function harness() {
  const data = {}, calls = [], listeners = {}, state = { pages: [], ready: true, failFlush: false, tabs: [{ id: 1, url: 'https://x.com/home', status: 'complete' }] };
  const api = {
    runtime: { getManifest() { return { content_scripts: [{ matches: ['https://*.x.com/*'], js: ['sites.js', 'lifecycle.js', 'content.js'] }] }; }, async getContexts() { return state.pages; }, reload() { calls.push('reload'); }, onUpdateAvailable: { addListener(fn) { listeners.available = fn; } } },
    storage: { local: { async get() { return structuredClone(data); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; } } },
    alarms: { async create() {}, async clear() {} },
    tabs: { async query() { return structuredClone(state.tabs); }, async sendMessage(id, message) { calls.push(message.type); return { ready: state.ready }; } },
    scripting: { async executeScript(details) { calls.push(structuredClone(details)); } }
  };
  const updates = Updates.create(api, task => task(), async () => { calls.push('flush'); if (state.failFlush) throw new Error('Storage full'); });
  return { data, calls, state, updates, listeners, api };
}

test('downloaded updates prepare clients, finish writes and commit before reload', async () => {
  const h = harness(); await h.updates.available({ version: '0.0.5' });
  assert.deepEqual(h.calls, ['prepare-update', 'flush', 'commit-update', 'flush', 'reload']);
  assert.equal(h.data._pendingUpdate, '0.0.5');
});

test('automatic updates defer open extension pages and failed deliveries without dropping the pending version', async () => {
  const h = harness(); h.state.pages = [{}]; await h.updates.available({ version: '0.0.5' });
  assert.deepEqual(h.calls, []);
  h.state.pages = []; h.state.ready = false; await h.updates.attempt();
  assert.deepEqual(h.calls, ['prepare-update', 'resume-update']);
  h.state.ready = true; h.state.failFlush = true; await h.updates.attempt();
  assert.equal(h.calls.includes('reload'), false); assert.equal(h.calls.at(-1), 'resume-update');
  h.state.failFlush = false; await h.updates.attempt(); assert.equal(h.calls.at(-1), 'reload');
});

test('a replacement worker restores committed clients before deferring an update for an open extension page', async () => {
  const h = harness(); let live = true, reached;
  const committed = new Promise(resolve => { reached = resolve; });
  h.api.tabs.sendMessage = async (id, message) => {
    if (!live) throw new Error('Could not establish connection. Receiving end does not exist.');
    if (message.type === 'commit-update') live = false;
    return { ready: true };
  };
  h.api.scripting.executeScript = async () => { live = true; };
  const first = Updates.create(h.api, task => task(), async () => {
    if (!live) { reached(); await new Promise(() => {}); }
  });
  void first.available({ version: '0.0.5' });
  await committed; assert.equal(live, false);
  h.state.pages = [{}];
  const replacement = Updates.create(h.api, task => task(), async () => {});
  await replacement.start();
  assert.equal(live, true, 'a stopped website document must recover without navigation');
  assert.equal(h.data._pendingUpdate, '0.0.5');
  assert.equal(h.data._updateRecovery, undefined);
  assert.equal(h.calls.includes('reload'), false);
});

test('failed recovery remains durable and retries even after the pending version was cleared', async t => {
  const h = harness(), alarms = new Set(); let failing = true, injections = 0;
  t.mock.method(console, 'error', () => {});
  h.data._updateRecovery = true; h.state.pages = [{}];
  h.api.alarms.create = async name => { alarms.add(name); };
  h.api.alarms.clear = async name => { alarms.delete(name); };
  h.api.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist.'); };
  h.api.scripting.executeScript = async () => { injections++; if (failing) throw new Error('Injection temporarily unavailable'); };
  await h.updates.start();
  assert.equal(injections, 1); assert.equal(h.data._updateRecovery, true);
  assert.equal(alarms.has('extension-update'), true);
  failing = false; await h.updates.attempt();
  assert.equal(injections, 2); assert.equal(h.data._updateRecovery, undefined);
  assert.equal(alarms.has('extension-update'), false);
  assert.equal(h.calls.includes('reload'), false);
});

test('recovery state must be persisted before any client can be stopped', async () => {
  const h = harness(), set = h.api.storage.local.set;
  h.api.storage.local.set = async values => { if (values._updateRecovery) throw new Error('Storage full'); return set(values); };
  await h.updates.available({ version: '0.0.5' });
  assert.equal(h.calls.includes('commit-update'), false);
  assert.equal(h.calls.includes('reload'), false);
  assert.equal(h.calls.at(-1), 'resume-update');
});

test('discarded tabs cannot block updates or receive script reinjection', async () => {
  const h = harness(); h.state.tabs.push({ id: 2, url: 'https://x.com/explore', status: 'complete', discarded: true });
  h.api.tabs.sendMessage = async (id, message) => {
    assert.notEqual(id, 2, 'discarded tabs have no live receiver');
    h.calls.push(message.type); return { ready: true };
  };
  await h.updates.available({ version: '0.0.5' });
  assert.equal(h.calls.at(-1), 'reload');
  await h.updates.installed({ reason: 'update' });
  assert.equal(h.calls.some(call => call.target?.tabId === 2), false);
});

test('startup cannot reinstall the version whose installation is still initializing', async () => {
  const h = harness(); let release;
  h.api.storage.local.get = () => new Promise(resolve => { release = () => resolve({ _pendingUpdate: '0.0.5' }); });
  const starting = h.updates.start();
  await h.updates.installed({ reason: 'update' }); release(); await starting;
  assert.equal(h.calls.includes('reload'), false);
});

test('worker replacement resumes a pending update; concurrent attempts reload only once', async () => {
  const h = harness(); h.data._pendingUpdate = '0.0.5';
  await h.updates.start();
  assert.equal(h.calls.filter(call => call === 'reload').length, 1);
  const other = harness(); other.state.pages = [{}]; await other.updates.available({ version: '0.0.5' }); other.state.pages = [];
  await Promise.all([other.updates.attempt(), other.updates.attempt(), other.updates.attempt()]);
  assert.equal(other.calls.filter(call => call === 'reload').length, 1);
});

test('navigation during preparation cancels installation and resumes the clients', async () => {
  const h = harness();
  h.api.tabs.sendMessage = async (id, message) => { h.calls.push(message.type); if (message.type === 'prepare-update') h.state.tabs[0].url = 'https://x.com/explore'; return { ready: true }; };
  await h.updates.available({ version: '0.0.5' });
  assert.equal(h.calls.includes('reload'), false); assert.equal(h.calls.at(-1), 'resume-update');
});

test('a browser reload failure restores the committed scripts and resumes without deleting pending state', async () => {
  const h = harness(); h.api.runtime.reload = () => { throw new Error('Reload refused'); };
  await h.updates.available({ version: '0.0.5' });
  assert.equal(h.calls.at(-1), 'resume-update'); assert.equal(h.data._pendingUpdate, '0.0.5');
  assert.ok(h.calls.some(call => call.files?.includes('content.js')));
});

test('pending updates survive replacement; install reinjects only matching manifest scripts without reloading the tab', async () => {
  const h = harness(); h.state.pages = [{}]; await h.updates.available({ version: '0.0.5' });
  await h.updates.installed({ reason: 'update' });
  assert.equal(h.data._pendingUpdate, undefined);
  assert.deepEqual(h.calls, ['prepare-update', 'commit-update', { target: { tabId: 1 }, files: ['sites.js', 'lifecycle.js', 'content.js'], world: 'ISOLATED' }]);
});
