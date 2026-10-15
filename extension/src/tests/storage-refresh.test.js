'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worker } = require('./background-harness.js');
const { page } = require('./ui-harness.js');

const start = new Date(2026, 9, 11, 12).getTime();
const idle = async (turns = 200) => { for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve)); };

async function settled(scene) {
  await idle(300);
  assert.equal(scene.capped, false, 'storage notifications must not feed back indefinitely');
  const writes = scene.writes;
  await idle(100);
  assert.equal(scene.writes, writes, 'no new writes without timers or user activity');
}

async function documents(names, adapter = 'chrome', websites = false) {
  const data = { _access: { x: { remainingMs: 300000 } } }, pages = [];
  let background, watching = false, writes = 0, capped = false;
  const storage = {
    async get(keys) {
      await new Promise(resolve => setImmediate(resolve));
      background.advance(1);
      const selected = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(data[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { oldValue: structuredClone(data[key]), newValue: structuredClone(value) }]));
      Object.assign(data, structuredClone(values));
      if (!watching || !Object.keys(changes).length) return;
      if (++writes >= 100) { capped = true; watching = false; return; }
      for (const document of pages) document.change(changes);
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
  background = worker(data, adapter, start, { localStorage: storage });
  await background.send({ type: 'snapshot' });
  if (websites) {
    background.grantWebsitePermissions();
    await background.send({ type: 'website-time-setting', enabled: true }, { id: 'test-extension', url: 'chrome-extension://test-extension/settings.html' });
  }
  background.activate('https://x.com/home');
  await background.send({ type: 'snapshot' });
  watching = true;
  for (const name of names) {
    const document = page(name, {}, false, {
      now: () => background.now,
      site: 'linkedin',
      forward: message => background.send(message, { id: 'test-extension', frameId: 0, url: 'chrome-extension://test-extension/' + name + '.html' + (name === 'blocked' ? '?site=linkedin' : '') })
    });
    pages.push(document);
  }
  return { pages, background, data, get writes() { return writes; }, get capped() { return capped; }, stop() { watching = false; } };
}

for (const adapter of ['chrome', 'browser']) {
  for (const websites of [false, true]) {
    for (const names of [['settings', 'settings'], ['settings', 'blocked'], ['popup', 'popup'], ['settings', 'dashboard']]) {
      test(`${adapter}: ${names.join(' + ')} settle with active access and Website time ${websites ? 'on' : 'off'}`, async t => {
        const scene = await documents(names, adapter, websites);
        t.after(() => scene.stop());
        await settled(scene);
        for (const document of scene.pages) assert.equal(document.nodes.error.textContent, '');
      });
    }
  }
}

test('access and settings changes still reach other documents; polling updates time and history', async t => {
  const scene = await documents(['settings', 'settings', 'popup', 'blocked', 'dashboard'], 'chrome', true);
  t.after(() => scene.stop());
  await settled(scene);
  const [settings, otherSettings, popup, blocked, dashboard] = scene.pages;
  const accessStatus = () => popup.nodes['access-sites'].children[0].children[0].children[1].textContent;
  const before = accessStatus();
  scene.background.advance(5000);
  popup.timer(1000);
  await settled(scene);
  assert.notEqual(accessStatus(), before, 'scheduled refresh keeps the countdown current');
  assert.ok(scene.data['_websiteTime:' + new Date(start).toLocaleDateString('en-CA')]['x.com'] >= 5);
  dashboard.nodes['websites-view'].fire('click');
  await settled(scene);
  assert.notEqual(dashboard.nodes['website-total'].textContent, '0s', 'website history remains readable');

  settings.nodes['track-x'].checked = false;
  await settings.nodes['track-x'].fire('change');
  await settled(scene);
  assert.equal(otherSettings.nodes['track-x'].checked, false);
  assert.equal(accessStatus(), 'Limit & track off');
  const intentions = 'Write a useful reply after the pause.';
  blocked.nodes.reason.value = intentions;
  blocked.nodes.request.fire('submit', { preventDefault() {} });
  await settled(scene);
  assert.equal(blocked.nodes.waiting.hidden, false);
  assert.match(popup.nodes['access-sites'].children[1].children[0].children[1].textContent, /Access requested/);
  await scene.background.send({ type: 'access-cancel', site: 'linkedin' }, { id: 'test-extension', frameId: 0, url: 'chrome-extension://test-extension/blocked.html?site=linkedin' });
  await settled(scene);
  assert.equal(blocked.nodes.waiting.hidden, true);
  assert.equal(blocked.nodes.request.hidden, false);
});
