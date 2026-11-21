'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const { worker, popupSender } = require('../tests/background-harness.js');
const { tracker } = require('../tests/content-harness.js');
const start = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(start));
const url = 'https://www.reddit.com/';
const sender = { id: 'test-extension', frameId: 0, tab: { id: 1 }, url };
async function settled() { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); }

for (const ending of ['alarm', 'manual', 'guard', 'backoff']) test(`gate navigation drains pending activity before destroying the document: ${ending}`, async () => {
  let t, destroyed = false, recordedAtNavigation, drained;
  const w = worker({ _access: { reddit: { remainingMs: 60000, expiresAt: start + 60000, date } } }, 'chrome', start, {
    session: { _accessInitialized: true },
    async sendTabMessage(id, message, target) {
      assert.equal(id, 1); assert.equal(target.frameId, 0);
      drained = await t.command(message); return drained;
    },
    onTabUpdate() { destroyed = true; recordedAtNavigation = w.data[date]?.reddit.consumeSec || 0; }
  });
  w.tabs.push({ id: 1, url }); w.activate(url);
  t = await tracker('chrome', { url, async forward(message) {
    if (ending === 'backoff' && message.type === 'ingest' && w.now >= start + 55000) throw new Error('Worker temporarily unavailable');
    const result = await w.send(message, sender);
    return destroyed ? new Promise(() => {}) : result;
  } });
  await settled(); t.input();
  for (let time = 5000; time <= 55000; time += 5000) {
    t.setNow(time); w.advance(5000); t.input(); await t.tick(); await settled();
  }
  const manual = ending === 'manual' || ending === 'backoff';
  const end = manual ? 59000 : 61000;
  t.setNow(end); w.advance(end - 55000); t.input();
  if (ending === 'alarm') { w.alarm('access-reddit'); await w.send({ type: 'snapshot' }); }
  else await w.send(manual ? { type: 'access-end', site: 'reddit' } : { type: 'access-status' }, manual ? popupSender : sender);
  assert.equal(recordedAtNavigation, manual ? 59 : 60);
  assert.equal(w.tabs[0].url.endsWith('blocked.html?site=reddit'), true);
  assert.ok(drained.packets.length);
  for (const packet of drained.packets) assert.equal((await w.send(packet, sender)).ok, true);
  assert.equal(w.data[date].reddit.consumeSec, recordedAtNavigation);
});

for (const receiver of ['empty', 'missing', 'unresponsive', 'malformed', 'wrong-site', 'stale-generation']) test(`gate navigation remains bounded with a ${receiver} tracker`, { timeout: 3000 }, async () => {
  const packet = { type: 'ingest', id: 'drain-invalid', site: receiver === 'wrong-site' ? 'x' : 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [], ...(receiver === 'stale-generation' ? { generation: 'old' } : {}) };
  const w = worker({ _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } } }, 'chrome', start, {
    session: { _accessInitialized: true },
    sendTabMessage() {
      if (receiver === 'missing') throw new Error('No receiving end');
      if (receiver === 'unresponsive') return new Promise(() => {});
      return receiver === 'empty' ? { packets: [] } : receiver === 'malformed' ? { packets: [null] } : { packets: [packet] };
    }
  });
  w.activate(url);
  await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url });
  w.advance(1100);
  const before = performance.now();
  await w.send({ type: 'snapshot' });
  assert.equal(w.tabs[0].url.endsWith('blocked.html?site=reddit'), true);
  assert.ok(performance.now() - before < 2000);
  assert.equal(w.data[date], undefined);
});

test('concurrent tab drains retain both histories and receipts', async () => {
  const w = worker({ _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } } }, 'chrome', start, {
    session: { _accessInitialized: true },
    sendTabMessage(id) {
      return { packets: [{ type: 'ingest', id: 'tab-' + id, site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] }] };
    }
  });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }, { id: 2, url }); w.advance(1100);
  await w.send({ type: 'snapshot' });
  assert.equal(w.data[date].reddit.consumeSec, 2);
  assert.ok(w.data._receipts.includes('tab-1'));
  assert.ok(w.data._receipts.includes('tab-2'));
});

test('an ingest cannot replay after its expiry drain rotates the receipt window', async () => {
  const generation = 'recognized-window';
  const packet = id => ({ type: 'ingest', id, generation, site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] });
  const incoming = packet('in-flight');
  const w = worker({
    _historyGeneration: generation,
    _receipts: Array.from({ length: C.DELIVERY_LIMITS.receiptLimit - 1 }, (_, n) => 'known-' + n),
    _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } }
  }, 'chrome', start, {
    session: { _accessInitialized: true },
    sendTabMessage() { return { packets: [incoming, packet('rollover')] }; }
  });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }); w.advance(1100);
  assert.equal((await w.send(incoming, sender)).ok, true);
  assert.notEqual(w.data._historyGeneration, generation);
  assert.equal(w.data[date].reddit.consumeSec, 2);
  assert.equal(w.data._receipts.includes(incoming.id), false);
  await w.send(incoming, sender);
  assert.equal(w.data[date].reddit.consumeSec, 2);
});

test('a failed tab navigation preserves the requesting guard fallback after draining', async () => {
  let drains = 0;
  const w = worker({ _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } } }, 'chrome', start, {
    session: { _accessInitialized: true },
    sendTabMessage() { drains++; return { packets: [] }; },
    onTabUpdate() { throw new Error('Tab update failed'); }
  });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }); w.advance(1100);
  const result = await w.send({ type: 'access-status' }, sender);
  assert.equal(result.ok, true);
  assert.ok(drains > 0);
  assert.equal(result.navigationHandled, false);
  assert.equal(w.tabs[0].url, url);
});

for (const correction of [-3600000, -1500]) test(`backward clock correction preserves historical and current authorization: ${correction}`, async () => {
  const w = worker({ _access: { reddit: { remainingMs: 60000, expiresAt: start + 60000, date } } }, 'chrome', start, { session: { _accessInitialized: true } });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.advance(1000 + correction);
  await w.send({ type: 'snapshot' });
  const corrected = w.now;
  w.advance(1000);
  await w.send({ type: 'access-end', site: 'reddit' }, popupSender);
  const packet = { type: 'ingest', id: 'clock-correction', site: 'reddit', segments: [
    { date, mode: 'consume', start, end: start + 1000, sec: 1 },
    { date, mode: 'consume', start: corrected, end: corrected + 1000, sec: 1 },
    ...(correction === -3600000 ? [{ date, mode: 'consume', start: corrected + 1000, end: corrected + 2000, sec: 1 }] : [])
  ], actions: [] };
  assert.equal((await w.send(packet, sender)).ok, true);
  assert.equal(w.data[date].reddit.consumeSec, 2);
  assert.ok(w.data._accessWindows.reddit.every(window => window.end > window.start));
});

test('a failed drained history write cannot prevent gate navigation or create retry state', async () => {
  const session = { _accessInitialized: true };
  const packet = { type: 'ingest', id: 'failed-drain', site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] };
  const w = worker({ _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } } }, 'chrome', start, {
    session,
    sendTabMessage() { w.failWrites = true; return { packets: [packet] }; },
    onTabUpdate() { w.failWrites = false; }
  });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }); w.advance(1100);
  assert.equal((await w.send({ type: 'snapshot' })).ok, true);
  assert.equal(w.tabs[0].url.endsWith('blocked.html?site=reddit'), true);
  assert.equal(w.data[date], undefined);
  assert.equal(Object.keys(session).some(key => key.startsWith('_drain')), false);
  assert.equal(w.alarms['drain-retry'], undefined);
});

test('a drain records its entire admitted generation across receipt rollover without replaying duplicates', async () => {
  const generation = 'recognized-window';
  const packets = ['first', 'rollover', 'last', 'first', 'known-0'].map(id => ({ type: 'ingest', id, generation, site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] }));
  const w = worker({
    _historyGeneration: generation,
    _receipts: Array.from({ length: C.DELIVERY_LIMITS.receiptLimit - 1 }, (_, n) => 'known-' + n),
    _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } }
  }, 'chrome', start, { session: { _accessInitialized: true }, sendTabMessage() { return { packets }; } });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }); w.advance(1100);
  await w.send({ type: 'snapshot' });
  assert.equal(w.data[date].reddit.consumeSec, 3);
  assert.notEqual(w.data._historyGeneration, generation);
  for (const packet of packets) await w.send(packet, sender);
  assert.equal(w.data[date].reddit.consumeSec, 3);
});

test('expiry snapshots include the history and generation produced by their drain', async () => {
  const generation = 'before-drain';
  const packets = ['first', 'rollover'].map(id => ({ type: 'ingest', id, generation, site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] }));
  const w = worker({ _historyGeneration: generation,
    _receipts: Array.from({ length: C.DELIVERY_LIMITS.receiptLimit - 1 }, (_, n) => 'known-' + n),
    _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } }
  }, 'chrome', start, { session: { _accessInitialized: true }, sendTabMessage() { return { packets }; } });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }); w.advance(1100);
  const reply = await w.send({ type: 'snapshot' });
  assert.notEqual(w.data._historyGeneration, generation);
  assert.equal(reply.generation, w.data._historyGeneration);
  assert.equal(reply.day.reddit.consumeSec, 2);
});

test('concurrent drains admit their generation before a slower tab responds', async () => {
  const generation = 'recognized-window';
  let release;
  const navigated = new Promise(resolve => { release = resolve; });
  const w = worker({
    _historyGeneration: generation,
    _receipts: Array.from({ length: C.DELIVERY_LIMITS.receiptLimit - 1 }, (_, n) => 'known-' + n),
    _access: { reddit: { remainingMs: 1000, expiresAt: start + 1000, date } }
  }, 'chrome', start, {
    session: { _accessInitialized: true },
    async sendTabMessage(id) {
      if (id === 2) await navigated;
      return { packets: Array.from({ length: 3 }, (_, n) => ({ type: 'ingest', id: `tab-${id}-${n}`, generation, site: 'reddit', segments: [{ date, mode: 'consume', start, end: start + 1000, sec: 1 }], actions: [] })) };
    },
    onTabUpdate(id) { if (id === 1) release(); }
  });
  w.activate(url); await w.send({ type: 'snapshot' });
  w.tabs.push({ id: 1, url }, { id: 2, url }); w.advance(1100);
  await w.send({ type: 'snapshot' });
  assert.equal(w.data[date].reddit.consumeSec, 6);
});
