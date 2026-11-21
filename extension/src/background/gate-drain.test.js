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
