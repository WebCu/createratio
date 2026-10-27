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
