'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worker, gate, intent, rulesFor } = require('./background-harness.js');
const { tracker } = require('./content-harness.js');
const { Element } = require('../../sites/test-support.js');
const { page, C3 } = require('./ui-harness.js');

const start = new Date(2026, 9, 11, 12).getTime();
const date = C3.localDate(new Date(start));
const sender = name => ({ id: 'test-extension', url: `chrome-extension://test-extension/${name}.html` });

async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), description);
}

async function ui(w, name) {
  const p = page(name, {}, false, { now: () => w.now, forward: message => w.send(message, name === 'blocked' ? gate('x') : sender(name)) });
  await until(() => name === 'blocked' ? !p.nodes.begin.disabled : name === 'settings' ? !!p.nodes['track-x'] : !!p.nodes.date.dateTime, `${name} loads through the worker`);
  assert.equal(p.nodes.error.textContent, '');
  return p;
}

function accessRow(p) {
  return p.nodes['access-sites'].children.find(row => row.children[0].children[0].textContent === 'X');
}

async function preferences(w, minutes) {
  const p = await ui(w, 'settings');
  p.nodes['accessMinutes-default'].value = String(minutes);
  p.nodes['accessMinutes-default'].fire('change');
  await until(() => p.nodes['save-status'].textContent.includes('session time saved'), 'duration saved through Settings');
  p.nodes['intention-history-enabled'].checked = true;
  await p.nodes['intention-history-enabled'].fire('change');
  assert.match(p.nodes['save-status'].textContent, /intentions will be saved/);
  return p;
}

async function request(w) {
  const p = await ui(w, 'blocked');
  p.nodes.reason.value = intent;
  p.nodes.request.fire('submit', { preventDefault() {} });
  await until(() => !p.nodes.waiting.hidden && !p.nodes.reason.disabled, 'intention acknowledged by the worker');
  return p;
}

async function openSession(w) {
  const p = await request(w);
  w.advance(60000);
  p.timer(1000);
  await p.nodes.open.fire('click');
  assert.deepEqual(p.state.redirects, ['https://x.com/home']);
  return p;
}

async function score(w, expected, posts) {
  const popup = await ui(w, 'popup');
  const dashboard = await ui(w, 'dashboard');
  assert.equal(popup.nodes.score.textContent, expected);
  assert.equal(dashboard.nodes.score.textContent, expected);
  assert.equal(dashboard.nodes.posts.textContent, posts);
  assert.deepEqual(popup.state.storageReads, ['_pendingUpdate']);
  assert.deepEqual(dashboard.state.storageReads, ['_pendingUpdate']);
  return { popup, dashboard };
}

function csvRows(csv) {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const fields = header.split(',');
  return rows.map(row => Object.fromEntries(row.split(',').map((value, index) => [fields[index], value])));
}

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: modern LinkedIn post writing saves exact creating time without idle, hidden, unfocused or blocked time`, async () => {
    const url = 'https://www.linkedin.com/sharing/compose';
    const source = { id: 'test-extension', tab: { id: 1 }, frameId: 0, url };
    const w = worker({ _access: { linkedin: { remainingMs: 300000, date } } }, browser, start);
    w.activate(url);
    let ready = false, pending = 0;
    const t = await tracker(browser, { url, standalonePost: true, forward: async message => {
      pending++;
      try {
        const response = await w.send(message, source);
        ready = true;
        return response;
      } finally { pending--; }
    } });
    await until(() => ready, 'modern post tracker loads worker preferences');
    t.route(url, true);
    async function sample(ms) {
      w.advance(ms);
      t.setNow(w.now - start);
      await t.tick();
      await until(() => pending === 0, 'tracker deliveries finish before reading totals');
      return (await w.send({ type: 'snapshot' }, source)).day.linkedin?.createSec || 0;
    }
    t.input(false);
    assert.equal(await sample(5000), 0, 'synthetic typing is ignored');
    for (const expected of [5, 10, 15, 20]) {
      t.input();
      assert.equal(await sample(5000), expected, 'twenty seconds of writing saves twenty seconds');
    }
    const popup = await ui(w, 'popup');
    const dashboard = await ui(w, 'dashboard');
    assert.equal(popup.nodes['create-min'].textContent, '0.3m');
    assert.equal(dashboard.nodes['create-min'].textContent, '0.3m');
    const activity = (await w.send({ type: 'snapshot' }, source)).day.linkedin;
    for (const field of ['consumeSec', 'posts', 'comments', 'replies']) assert.equal(activity[field] || 0, 0);
    assert.equal(await sample(2000), 22);
    t.focus(false);
    assert.equal(await sample(5000), 22, 'unfocused writing adds no time');
    t.focus(true);
    t.visible(false);
    assert.equal(await sample(5000), 22, 'hidden writing adds no time');
    t.visible(true);
    t.input();
    for (const expected of [27, 32, 37, 42, 47, 52, 52]) assert.equal(await sample(5000), expected, 'idle writing stops at thirty seconds');
    t.input();
    assert.equal(await sample(20000), 52, 'a sleep gap is not backfilled');
    t.input();
    assert.equal(await sample(5000), 57, 'fresh typing resumes saving');
    t.document.activeElement = t.document.body.append(new Element(['[role="textbox"][contenteditable="true"]']));
    t.event('focusin', {});
    t.input();
    assert.equal(await sample(5000), 57, 'an unrelated textbox does not earn creating time');
    t.document.activeElement = t.editor;
    t.event('focusin', {});
    assert.equal((await w.send({ type: 'access-end', site: 'linkedin' }, sender('popup'))).ok, true);
    t.notify(); await sample(0);
    t.input();
    assert.equal(await sample(5000), 57, 'ending access stops creation tracking');
    assert.equal((await w.send({ type: 'access-goal-setting', enabled: true }, sender('settings'))).ok, true);
    t.notify(); await sample(0);
    t.input();
    assert.equal(await sample(5000), 62, 'above-goal access permits fresh writing without a session');
    assert.equal((await w.send({ type: 'tracking', site: 'linkedin', enabled: false }, sender('settings'))).ok, true);
    t.notify(); await sample(0);
    t.input();
    assert.equal(await sample(5000), 62, 'Limit & track Off cannot record writing even above the goal');
    assert.deepEqual(w.errors, []);
    assert.deepEqual(t.warnings, []);
  });

  test(`${browser}: intentional access travels from Settings and gate confirmation to paused popup timer and manual end`, async () => {
    const w = worker({}, browser, start);
    await preferences(w, 2);
    const popup = await ui(w, 'popup');
    assert.equal(accessRow(popup).children[0].children[1].textContent, 'Blocked');
    await accessRow(popup).children[1].fire('click');
    assert.match(popup.state.tabs.at(-1).url, /blocked\.html\?site=x$/);

    const blocked = await request(w);
    assert.equal(blocked.nodes.clock.textContent, '1:00');
    assert.equal(blocked.nodes.open.disabled, true);
    assert.match(blocked.nodes['reason-hint'].textContent, /saved on this device/);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 0);

    w.advance(30000);
    const reloaded = await ui(w, 'blocked');
    assert.equal(reloaded.nodes.clock.textContent, '0:30');
    assert.equal(reloaded.nodes.open.disabled, true);
    w.advance(29000);
    reloaded.timer(1000);
    assert.equal(reloaded.nodes.clock.textContent, '0:01');
    assert.equal(reloaded.nodes.open.disabled, true);
    w.advance(1000);
    reloaded.timer(1000);
    assert.equal(reloaded.nodes.clock.textContent, '0:00');
    assert.equal(reloaded.nodes.open.disabled, false);
    assert.deepEqual(reloaded.state.redirects, []);
    assert.equal(reloaded.messages.some(message => message.type === 'access-open'), false);
    assert.equal((await w.send({ type: 'access-status' })).access.x.remainingMs, 0);
    assert.deepEqual(rulesFor(w), []);

    await reloaded.nodes.open.fire('click');
    assert.deepEqual(reloaded.state.redirects, ['https://x.com/home']);
    assert.equal(reloaded.nodes.active.hidden, false);
    assert.match(reloaded.nodes['active-time'].textContent, /2:00 remaining · paused/);
    assert.equal(w.data._intentions.length, 1);
    assert.equal(w.data._intentions[0].reason, intent);
    assert.equal(w.data._intentions[0].requestedAt, start);

    w.tabs.push({ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://twitter.com/home' });
    w.activate('https://x.com/home');
    let snapshot = await w.send({ type: 'snapshot' });
    assert.equal(snapshot.access.x.remainingMs, 120000);
    assert.ok(w.rules.length > 0);
    w.advance(20000);
    popup.refresh();
    await until(() => accessRow(popup).children[0].children[1].textContent === '1:40 left', 'popup displays elapsed active time');
    w.blur();
    snapshot = await w.send({ type: 'snapshot' });
    assert.equal(snapshot.access.x.remainingMs, 100000);
    assert.equal(snapshot.access.x.expiresAt, 0);
    popup.refresh();
    await until(() => accessRow(popup).children[0].children[1].textContent === '1:40 left · paused', 'popup displays paused time');
    w.advance(600000);
    const paused = await ui(w, 'popup');
    assert.equal(accessRow(paused).children[0].children[1].textContent, '1:40 left · paused');
    assert.equal((await w.send({ type: 'snapshot' })).access.x.remainingMs, 100000);
    w.activate('https://twitter.com/home', 2);
    await w.send({ type: 'snapshot' });
    w.advance(10000);
    const resumed = await ui(w, 'popup');
    assert.equal(accessRow(resumed).children[0].children[1].textContent, '1:30 left');
    assert.equal(accessRow(resumed).children[1].textContent, 'End session');
    const savedPreferences = structuredClone(w.data.settings);
    const intentions = structuredClone(w.data._intentions);
    await accessRow(resumed).children[1].fire('click');
    assert.equal(accessRow(resumed).children[0].children[1].textContent, 'Blocked');
    assert.equal((await w.send({ type: 'snapshot' })).access.x.remainingMs, 0);
    assert.deepEqual(rulesFor(w), []);
    assert.deepEqual(w.tabs.map(tab => tab.url), [gate('x').url, gate('x').url]);
    assert.deepEqual(w.data.settings, savedPreferences);
    assert.deepEqual(w.data._intentions, intentions);
    const dashboard = await ui(w, 'dashboard');
    dashboard.nodes['intentions-view'].fire('click');
    await until(() => dashboard.nodes['intention-list'].children.length === 1, 'saved intention remains reviewable after ending access');
    assert.equal(dashboard.nodes['intention-list'].children[0].children[1].textContent, intent);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: trusted activity reaches scores and CSV; confirmed clearing rejects delayed history and fresh input resumes`, async () => {
    const w = worker({}, browser, start);
    const settings = await preferences(w, 3);
    await openSession(w);
    w.grantWebsitePermissions();
    settings.nodes['website-time-enabled'].checked = true;
    await settings.nodes['website-time-enabled'].fire('change');
    await until(() => !settings.nodes['website-time-enabled'].disabled, 'website time enabled');
    w.activate('https://example.test/');
    await w.send({ type: 'snapshot' });
    w.advance(12000);
    await w.send({ type: 'snapshot' });
    settings.nodes['website-time-enabled'].checked = false;
    await settings.nodes['website-time-enabled'].fire('change');
    assert.equal(w.data['_websiteTime:' + date]['example.test'], 12);
    w.activate('https://x.com/home');
    await w.send({ type: 'snapshot' });

    const deliveries = [];
    let delayNext = false, pending, release;
    const t = await tracker(browser, { forward: async message => {
      const packet = structuredClone(message);
      if (packet.type === 'ingest' && delayNext) {
        delayNext = false;
        pending = packet;
        await new Promise(resolve => { release = resolve; });
      }
      const response = await w.send(packet);
      deliveries.push({ packet, response });
      return response;
    } });
    await until(() => deliveries.length > 0, 'tracker loads the real worker snapshot');
    t.setNow(w.now - start);
    t.input();
    for (let tick = 0; tick < 12; tick++) {
      w.advance(5000);
      t.setNow(w.now - start);
      await t.tick();
      await until(() => w.data[date]?.x.consumeSec === (tick + 1) * 5, 'tracked time reaches storage');
      t.input();
    }
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
    await until(() => w.data[date]?.x.posts === 1, 'trusted submission recorded');
    t.event('click', { isTrusted: true, target: t.button });
    await t.tick();
    assert.equal(w.data[date].x.posts, 1);
    assert.equal(w.data[date].x.consumeSec, 60);
    const { dashboard } = await score(w, '2.00', 1);
    assert.equal(dashboard.nodes['consume-min'].textContent, '1.0m');
    await dashboard.nodes.export.fire('click');
    assert.equal(dashboard.state.downloads[0].filename, `CreateRatio-${date}.csv`);
    const csv = await dashboard.blobs[0].text();
    const row = csvRows(csv).find(row => row.site === 'x');
    assert.equal(row.date, date);
    assert.equal(row.posts, '1');
    assert.equal(row.consumeSec, '60.000');
    assert.equal(row.score, '2.000');
    assert.equal(csv.includes(intent), false);
    dashboard.nodes['websites-view'].fire('click');
    await until(() => dashboard.nodes['website-total'].textContent === '12s', 'recorded website time is visible');
    await settings.nodes['export-websites'].fire('click');
    assert.equal(settings.state.downloads.at(-1).filename, `CreateRatio-websites-${date}.csv`);
    assert.equal(await settings.blobs.at(-1).text(), `date,domain,seconds\r\n${date},"example.test",12.000\r\n`);

    settings.state.confirm = false;
    const beforeCancel = structuredClone(w.data);
    await settings.nodes['clear-history'].fire('click');
    assert.deepEqual(w.data, beforeCancel);
    assert.equal(settings.messages.some(message => message.type === 'clear-history'), false);
    assert.match(settings.state.confirmations[0], /cannot be undone/);

    w.advance(5000);
    t.setNow(w.now - start);
    delayNext = true;
    t.event('click', { isTrusted: true, target: t.button });
    await until(() => !!pending, 'a pre-clear submission is delayed in transport');
    assert.equal(pending.actions[0].action, 'posts');
    assert.equal(pending.segments[0].sec, 5);
    await w.send({ type: 'snapshot' });
    const beforeClear = structuredClone(w.data);
    settings.state.confirm = true;
    await settings.nodes['clear-history'].fire('click');
    assert.match(settings.nodes['save-status'].textContent, /History cleared/);
    assert.equal(settings.nodes['clear-history'].disabled, false);
    assert.equal(w.data[date], undefined);
    assert.equal(w.data['_websiteTime:' + date], undefined);
    for (const key of ['settings', '_intentions', '_access', '_websiteTimeEnabled']) assert.deepEqual(w.data[key], beforeClear[key]);
    assert.notEqual(w.data._historyGeneration, pending.generation);
    await score(w, '0.00', 0);

    release();
    await until(() => deliveries.some(delivery => delivery.packet.id === pending.id), 'delayed packet receives the reset generation');
    const stale = deliveries.find(delivery => delivery.packet.id === pending.id);
    assert.equal(stale.response.ok, true);
    assert.equal(stale.response.generation, w.data._historyGeneration);
    assert.equal(w.data[date], undefined);
    assert.equal(w.data['_websiteTime:' + date], undefined);
    w.advance(10000);
    t.setNow(w.now - start);
    await t.tick();
    t.input(false);
    t.event('click', { isTrusted: false, target: t.button });
    await t.tick();
    assert.equal(w.data[date], undefined);
    await score(w, '0.00', 0);
    const cleared = await ui(w, 'dashboard');
    await cleared.nodes.export.fire('click');
    assert.equal(csvRows(await cleared.blobs[0].text()).length, 0);
    cleared.nodes['websites-view'].fire('click');
    await until(() => cleared.nodes['website-total'].textContent === '0s', 'website history remains cleared');
    cleared.nodes['intentions-view'].fire('click');
    await until(() => cleared.nodes['intention-list'].children.length === 1, 'clear preserves saved intentions');
    assert.equal(cleared.nodes['intention-list'].children[0].children[1].textContent, intent);

    t.input();
    w.advance(5000);
    t.setNow(w.now - start);
    await t.tick();
    await until(() => w.data[date]?.x.consumeSec === 5, 'only fresh trusted time resumes');
    t.event('keydown', { isTrusted: true, key: 'Enter', ctrlKey: true, target: t.editor });
    await until(() => w.data[date]?.x.posts === 1, 'a fresh trusted submission resumes');
    assert.equal(w.data[date].x.consumeSec, 5);
    assert.equal(w.data[date].x.createSec, 0);
    const fresh = deliveries.filter(delivery => delivery.packet.type === 'ingest' && delivery.packet.id !== pending.id).at(-1);
    assert.equal(fresh.packet.generation, w.data._historyGeneration);
    await score(w, '24.00', 1);
    assert.deepEqual(w.data.settings, beforeClear.settings);
    assert.deepEqual(w.data._intentions, beforeClear._intentions);
    assert.deepEqual(w.errors, []);
    assert.deepEqual(t.warnings, []);
  });
}
