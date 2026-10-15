'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { worker, gate, intent, popupSender } = require('./background-harness.js');
const { configuration, random, caseSeed, replayCommand, runCases } = require('./property-harness.js');

const config = configuration();
const start = new Date(2026, 9, 11, 12).getTime();
const date = '2026-10-11';
const sites = ['x', 'linkedin'];
const urls = { x: 'https://x.com/home', linkedin: 'https://www.linkedin.com/feed/', away: 'https://example.test/' };
const historySender = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html' };
const fields = ['consumeSec', 'createSec', 'posts', 'replies', 'comments', 'likes', 'bookmarks', 'quotes', 'reposts'];

async function ok(w, message, sender) {
  const result = await w.send(message, sender);
  assert.equal(result.ok, true, `${message.type}: ${result.error || 'unsuccessful response'}`);
  return result;
}

async function accessCase({ random, step, steps }, adapter) {
  let session = {}, w = worker({ settings: { trackedSites: sites } }, adapter, start, { session });
  const budget = { x: 0, linkedin: 0 }, enabled = { x: true, linkedin: true }, minutes = { x: 5, linkedin: 5 };
  let focus = null, now = start, tab = 1;
  const elapse = ms => {
    if (sites.includes(focus)) budget[focus] = Math.max(0, budget[focus] - ms);
    now += ms;
    w.advance(ms);
  };
  const check = async () => {
    const { access } = await ok(w, { type: 'access-status' });
    for (const site of sites) {
      assert.ok(access[site].remainingMs >= 0, `${site}: nonnegative budget`);
      assert.equal(access[site].remainingMs, budget[site], `${site}: only focused time burns; switches and wakes cannot refill`);
      assert.equal(access[site].enabled, enabled[site]);
      assert.equal(access[site].sessionMinutes, minutes[site]);
      assert.equal(access[site].expiresAt, focus === site && budget[site] ? now + budget[site] : 0, `${site}: paused access has no active deadline`);
    }
    assert.deepEqual(w.errors, []);
  };
  const apply = async command => {
    const { type, site } = command;
    if (type === 'focus') {
      focus = site;
      w.activate(command.alias ? 'https://twitter.com/home' : urls[site], ++tab);
    } else if (type === 'blur') {
      focus = null;
      w.blur();
    } else if (type === 'time') elapse(command.ms);
    else if (type === 'replace') {
      if (command.cold) { now += command.ms; session = {}; }
      else elapse(command.ms);
      focus = command.focus;
      w = worker(w.data, adapter, now, { session });
      if (focus !== null) w.activate(urls[focus], ++tab);
    } else if (type === 'unlock') {
      await ok(w, { type: 'access-begin', site, reason: intent }, gate(site));
      if (enabled[site] && !budget[site]) {
        elapse(60000);
        await check();
        budget[site] = minutes[site] * 60000;
      }
      await ok(w, { type: 'access-open', site }, gate(site));
    } else if (type === 'end') {
      await ok(w, { type: 'access-end', site }, popupSender);
      budget[site] = 0;
    } else if (type === 'tracking') {
      enabled[site] = command.enabled;
      if (!enabled[site]) budget[site] = 0;
      await ok(w, { type: 'tracking', site, enabled: command.enabled }, popupSender);
    } else if (type === 'duration') {
      minutes[site] = command.minutes;
      await ok(w, { type: 'access-duration', site, minutes: command.minutes }, popupSender);
    }
    await check();
  };
  const prelude = [
    { type: 'unlock', site: 'x' }, { type: 'focus', site: 'x' }, { type: 'time', ms: 15000 },
    { type: 'focus', site: 'linkedin' }, { type: 'unlock', site: 'linkedin' }, { type: 'time', ms: 9000 },
    { type: 'blur' }, { type: 'time', ms: 10000 }, { type: 'replace', ms: 10000, cold: false, focus: null },
    { type: 'focus', site: 'x', alias: true }, { type: 'replace', ms: 5000, cold: false, focus: 'linkedin' },
    { type: 'replace', ms: 10000, cold: true, focus: 'x' }, { type: 'time', ms: 300000 },
    { type: 'tracking', site: 'x', enabled: false }, { type: 'tracking', site: 'x', enabled: true }
  ];
  for (const command of prelude) await step(command, apply);
  for (let n = 0; n < steps; n++) {
    const type = random.pick(['focus', 'focus', 'blur', 'time', 'time', 'replace', 'unlock', 'end', 'tracking', 'duration', 'status']);
    const site = random.pick(sites);
    let command = { type, site };
    if (type === 'focus') command = { type, site: random.pick([...sites, 'away']) };
    if (type === 'time') command = { type, ms: random.pick([0, 1, 1000, 7000, 15000]) };
    if (type === 'replace') command = { type, ms: random.pick([0, 1000, 10000]), cold: random.integer(4) === 0, focus: random.pick([...sites, 'away', null]) };
    if (type === 'tracking') command.enabled = random.integer(2) === 1;
    if (type === 'duration') command.minutes = random.pick([1, 2, 5]);
    await step(command, apply);
  }
}

async function deliveryCase({ random, step, steps }, adapter) {
  const session = {};
  let w = worker({ settings: { trackedSites: sites }, _access: { x: { remainingMs: 300000 }, linkedin: { remainingMs: 300000 } },
    _historyGeneration: 'property-initial', _receipts: Array.from({ length: 511 }, (_, n) => `fixture-${n}`),
    [date]: { x: { consumeSec: 7, posts: 2 }, linkedin: { createSec: 3, posts: 1 } },
    ['_websiteTime:' + date]: { 'example.test': 11 }
  }, adapter, start, { session });
  const totals = { x: { consumeSec: 7, createSec: 0, posts: 2 }, linkedin: { consumeSec: 0, createSec: 3, posts: 1 } };
  const enabled = { x: true, linkedin: true }, unlocked = { x: true, linkedin: true };
  const packets = [], credited = new Set();
  let generation = 'property-initial', websiteSeconds = 11;
  const check = async () => {
    const snapshot = await ok(w, { type: 'snapshot' });
    generation = snapshot.generation;
    for (const site of sites) {
      for (const field of fields) assert.equal(snapshot.day[site]?.[field] ?? 0, totals[site][field] ?? 0, `${site}.${field}: independent delivery ledger`);
      assert.equal(snapshot.settings.trackedSites.includes(site), enabled[site]);
      assert.equal(snapshot.access[site].remainingMs > 0, unlocked[site]);
    }
    const ratio = await ok(w, { type: 'history', kind: 'ratio', range: 'today' }, historySender);
    assert.deepEqual(ratio.days[date] || {}, snapshot.day);
    const websites = await ok(w, { type: 'history', kind: 'websites', range: 'today' }, historySender);
    assert.equal(websites.days[date]?.['example.test'] ?? 0, websiteSeconds);
  };
  const deliver = async (packet, fail = false) => {
    const eligible = packet.generation === generation && enabled[packet.site] && unlocked[packet.site] && !credited.has(packet.id);
    w.failWrites = fail;
    let result;
    try {
      result = await w.send(packet, { id: 'test-extension', tab: { id: packet.site === 'x' ? 1 : 2 }, frameId: 0, url: urls[packet.site] });
    } finally { w.failWrites = false; }
    assert.equal(result.ok, !(fail && eligible), 'failed saving must not acknowledge a new eligible packet');
    if (!result.ok) assert.equal(result.error, 'Storage unavailable');
    if (!fail && eligible) {
      credited.add(packet.id);
      totals[packet.site][packet.segments[0].mode + 'Sec'] += packet.segments[0].sec;
      totals[packet.site].posts += packet.actions.length;
    }
    if (result.ok) generation = result.generation;
  };
  const apply = async command => {
    const { type, site } = command;
    if (type === 'new' || type === 'failed-save') {
      const packet = { type: 'ingest', id: `packet-${packets.length}`, generation, site,
        segments: [{ date, mode: command.mode, sec: command.sec }], actions: Array.from({ length: command.posts }, () => ({ date, action: 'posts' })) };
      packets.push(packet);
      await deliver(packet, type === 'failed-save');
    } else if (type === 'retry' && packets.length) await deliver(packets[command.index % packets.length]);
    else if (type === 'clear' || type === 'failed-clear') {
      const before = generation;
      w.failWrites = type === 'failed-clear';
      let result;
      try { result = await w.send({ type: 'clear-history' }, popupSender); }
      finally { w.failWrites = false; }
      assert.equal(result.ok, type === 'clear');
      if (!result.ok) assert.equal(result.error, 'Storage unavailable');
      if (result.ok) {
        assert.equal(typeof result.generation, 'string');
        assert.notEqual(result.generation, before, 'confirmed clear must fence the previous generation');
        generation = result.generation;
        for (const site of sites) totals[site] = { consumeSec: 0, createSec: 0, posts: 0 };
        websiteSeconds = 0;
      }
    } else if (type === 'replace') w = worker(w.data, adapter, w.now, { session });
    else if (type === 'tracking') {
      enabled[site] = command.enabled;
      if (!enabled[site]) unlocked[site] = false;
      await ok(w, { type: 'tracking', site, enabled: command.enabled }, popupSender);
    } else if (type === 'unlock') {
      await ok(w, { type: 'access-begin', site, reason: intent }, gate(site));
      if (enabled[site] && !unlocked[site]) w.advance(60000);
      await ok(w, { type: 'access-open', site }, gate(site));
      if (enabled[site]) unlocked[site] = true;
    }
    await check();
  };
  const fresh = (site = 'x') => ({ type: 'new', site, mode: 'consume', sec: 3, posts: 1 });
  const prelude = [
    fresh(), { type: 'retry', index: 0 }, fresh('linkedin'), { type: 'replace' }, { type: 'retry', index: 1 },
    { type: 'retry', index: 0 }, { ...fresh(), type: 'failed-save' }, { type: 'replace' }, { type: 'retry', index: 2 },
    { type: 'retry', index: 2 }, { ...fresh(), type: 'failed-save' }, { type: 'failed-clear' }, { type: 'clear' },
    { type: 'retry', index: 3 }, { type: 'replace' }, { type: 'retry', index: 3 },
    { type: 'retry', index: 2 }, fresh(), { type: 'tracking', site: 'x', enabled: false }, fresh(),
    { type: 'tracking', site: 'x', enabled: true }, fresh(), { type: 'unlock', site: 'x' },
    { type: 'retry', index: 5 }, { type: 'retry', index: 5 }, { type: 'retry', index: 4 }
  ];
  await check();
  for (const command of prelude) await step(command, apply);
  for (let n = 0; n < steps; n++) {
    const type = random.pick(['new', 'new', 'retry', 'retry', 'failed-save', 'clear', 'failed-clear', 'replace', 'tracking', 'unlock', 'snapshot']);
    const command = { type, site: random.pick(sites) };
    if (type === 'new' || type === 'failed-save') Object.assign(command, { mode: random.pick(['consume', 'create']), sec: random.pick([1, 3, 9]), posts: random.integer(3) });
    if (type === 'retry') command.index = random.integer(1000);
    if (type === 'tracking') command.enabled = random.integer(2) === 1;
    await step(command, apply);
  }
}

test('seeded commands and failure reports are reproducible', async () => {
  const draw = seed => {
    const rng = random(seed);
    return Array.from({ length: 12 }, () => rng.integer(1000));
  };
  assert.deepEqual(draw(0), [266, 0, 223, 146, 467, 545, 615, 648, 456, 581, 246, 97]);
  assert.deepEqual(draw(caseSeed(123, 2)), draw(caseSeed(123, 2)));
  assert.notDeepEqual(draw(123), draw(124));
  const replayConfig = { seed: 42, cases: 2, steps: 3, case: 1 };
  const command = { type: 'time', ms: 7 };
  const failure = async () => {
    try {
      await runCases(replayConfig, 'chrome', 'access', async ({ step }) => {
        await step(command, async () => { assert.fail('sentinel'); });
      });
    } catch (error) { return error.message; }
    assert.fail('expected the sentinel failure');
  };
  assert.equal(await failure(), await failure());
  assert.ok((await failure()).includes(replayCommand(replayConfig, 'chrome', 'access', 1)));
  assert.ok((await failure()).includes(`Sequence: [${JSON.stringify(command)}]`));
});

for (const adapter of ['chrome', 'browser']) {
  if (config.adapter && config.adapter !== adapter) continue;
  for (const [machine, execute] of [['access', accessCase], ['delivery', deliveryCase]]) {
    if (config.machine && config.machine !== machine) continue;
    test(`${adapter}: seeded ${machine} lifecycle properties`, async t => {
      const began = performance.now();
      const transitions = await runCases(config, adapter, machine, context => execute(context, adapter));
      t.diagnostic(`seed=${config.seed}; ${transitions} transitions; ${(performance.now() - began).toFixed(0)}ms`);
    });
  }
}
