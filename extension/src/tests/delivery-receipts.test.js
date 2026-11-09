'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worker, popupSender } = require('./background-harness.js');
const { tracker } = require('./content-harness.js');
const start = new Date(2026, 9, 11, 12).getTime();
const date = '2026-10-11';
const otherTab = { id: 'test-extension', tab: { id: 2 }, frameId: 0, url: 'https://www.linkedin.com/feed/' };
const packet = (id, generation) => ({ type: 'ingest', id, generation, site: 'linkedin', segments: [{ date, mode: 'consume', sec: 1 }], actions: [] });
async function drain() {
  for (let n = 0; n < 40; n++) await new Promise(resolve => setImmediate(resolve));
}

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: a lost acknowledgement cannot double-count after 513 other-tab packets and worker replacement`, async () => {
    const session = {};
    let w = worker({ _access: { x: { remainingMs: 300000 }, linkedin: { remainingMs: 300000 } } }, browser, start, { session });
    let loseResponse = true;
    const attempts = [];
    const t = await tracker(browser, { async forward(message) {
      const result = await w.send(message);
      if (message.type === 'ingest') {
        attempts.push(structuredClone(message));
        if (loseResponse) throw new Error('Response lost');
      }
      return result;
    } });
    await drain();
    t.input(); t.setNow(5000); w.advance(5000);
    t.event('click', { isTrusted: true, target: t.button });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    assert.equal(w.data[date].x.consumeSec, 5);
    assert.equal(attempts.length, 1);
    t.setNow(6500); w.advance(1500);
    t.event('click', { isTrusted: true, target: t.button });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    assert.deepEqual(attempts[1], attempts[0]);
    let { generation } = await w.send({ type: 'snapshot' });
    for (let n = 0; n < 513; n++) {
      const result = await w.send(packet(`other-${n}`, generation), otherTab);
      assert.equal(result.ok, true);
      generation = result.generation;
      assert.ok(w.data._receipts.length <= 512);
    }
    assert.equal(w.data[date].linkedin.consumeSec, 513);
    w = worker(w.data, browser, w.now, { session });
    loseResponse = false;
    await t.tick(); await drain();
    assert.deepEqual(attempts.at(-1), attempts[0]);
    assert.equal(w.data[date].x.posts, 1);
    assert.equal(w.data[date].x.consumeSec, 5);
    assert.equal(w.data[date].linkedin.consumeSec, 513);
    t.setNow(11500); w.advance(5000);
    await t.tick(); await drain();
    assert.equal(w.data[date].x.consumeSec, 5);
    t.input(); t.setNow(16500); w.advance(5000);
    await t.tick(); await drain();
    assert.equal(w.data[date].x.consumeSec, 10);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: rollover during keyboard submission does not count its generated click again`, async () => {
    const w = worker({ _access: { x: { remainingMs: 300000 } }, _historyGeneration: 'keyboard-window', _receipts: Array.from({ length: 512 }, (_, n) => `prior-${n}`) }, browser, start);
    const t = await tracker(browser, { forward: message => w.send(message) });
    await drain();
    const { generation } = await w.send({ type: 'snapshot' });
    t.event('keydown', { isTrusted: true, key: 'Enter', [browser === 'chrome' ? 'ctrlKey' : 'metaKey']: true, target: t.editor });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    t.setNow(20); w.advance(20);
    t.event('click', { isTrusted: true, target: t.button });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    assert.equal(typeof w.data._historyGeneration, 'string');
    assert.notEqual(w.data._historyGeneration, generation);
    t.setNow(1500); w.advance(1480);
    t.event('keydown', { isTrusted: true, key: 'Enter', [browser === 'chrome' ? 'ctrlKey' : 'metaKey']: true, target: t.editor });
    await drain();
    assert.equal(w.data[date].x.posts, 2);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: a history-clear resync does not treat a keyboard submission's generated click as a new action`, async () => {
    const w = worker({ _access: { x: { remainingMs: 300000 } } }, browser, start);
    const t = await tracker(browser, { forward: message => w.send(message) });
    await drain();
    t.event('keydown', { isTrusted: true, key: 'Enter', [browser === 'chrome' ? 'ctrlKey' : 'metaKey']: true, target: t.editor });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    assert.equal((await w.send({ type: 'clear-history' }, popupSender)).ok, true);
    t.notify(); await t.tick(); await drain();
    t.setNow(20); w.advance(20);
    t.event('click', { isTrusted: true, target: t.button });
    await drain();
    assert.equal(w.data[date], undefined);
    t.setNow(1000); w.advance(980);
    t.event('keydown', { isTrusted: true, key: 'Enter', [browser === 'chrome' ? 'ctrlKey' : 'metaKey']: true, target: t.editor });
    await drain();
    assert.equal(w.data[date].x.posts, 1);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: rollover retires the journal and the next generation stays stable until its capacity is exceeded`, async () => {
    const w = worker({ _access: { linkedin: { remainingMs: 300000 } }, _receipts: Array.from({ length: 511 }, (_, n) => `legacy-${n}`) }, browser, start);
    const { generation } = await w.send({ type: 'snapshot' });
    const boundary = packet('unstructured boundary id', generation);
    assert.equal((await w.send(boundary, otherTab)).ok, true);
    assert.equal(w.data._receipts.length, 512);
    assert.equal((await w.send(boundary, otherTab)).generation, generation);
    assert.equal(w.data[date].linkedin.consumeSec, 1);
    const overflow = packet('unstructured rollover id', generation);
    const rolled = await w.send(overflow, otherTab);
    assert.equal(rolled.ok, true);
    assert.notEqual(rolled.generation, generation);
    assert.deepEqual(w.data._receipts, [overflow.id]);
    assert.equal((await w.send(overflow, otherTab)).generation, rolled.generation);
    await w.send(packet('legacy-0', generation), otherTab);
    assert.equal(w.data[date].linkedin.consumeSec, 2);
    for (let n = 0; n < 511; n++) {
      const result = await w.send(packet(n ? `fresh-${n}` : '', rolled.generation), otherTab);
      assert.equal(result.ok, true);
      assert.equal(result.generation, rolled.generation);
      assert.equal(w.data._receipts.length, n + 2);
    }
    const next = await w.send(packet('next-window', rolled.generation), otherTab);
    assert.equal(next.ok, true);
    assert.notEqual(next.generation, rolled.generation);
    assert.deepEqual(w.data._receipts, ['next-window']);
    assert.equal(w.data[date].linkedin.consumeSec, 514);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: failed rollover leaves totals, generation and receipts intact until an atomic retry succeeds`, async () => {
    const receipts = Array.from({ length: 512 }, (_, n) => `retained-${n}`);
    const w = worker({ _access: { linkedin: { remainingMs: 300000 } }, _historyGeneration: 'failure-window', _receipts: receipts, [date]: { linkedin: { consumeSec: 7 } } }, browser, start);
    const { generation } = await w.send({ type: 'snapshot' });
    const pending = packet('failed-rollover', generation);
    w.failWrites = true;
    assert.equal((await w.send(pending, otherTab)).ok, false);
    assert.equal(w.data[date].linkedin.consumeSec, 7);
    assert.deepEqual(w.data._receipts, receipts);
    assert.equal(w.data._historyGeneration ?? null, generation);
    w.failWrites = false;
    const committed = await w.send(pending, otherTab);
    assert.equal(committed.ok, true);
    assert.notEqual(committed.generation, generation);
    assert.deepEqual(w.data._receipts, [pending.id]);
    assert.equal(w.data[date].linkedin.consumeSec, 8);
    assert.equal((await w.send(pending, otherTab)).generation, committed.generation);
    assert.equal(w.data[date].linkedin.consumeSec, 8);
    assert.equal(w.errors.length, 1);
  });

  test(`${browser}: boot expires an ambiguous full legacy journal before accepting an already-evicted null-generation retry`, async () => {
    for (const generation of [undefined, null]) {
      const data = { _access: { linkedin: { remainingMs: 300000 } }, _receipts: Array.from({ length: 512 }, (_, n) => `legacy-${n}`), [date]: { linkedin: { consumeSec: 7, posts: 1 } } };
      if (generation === null) data._historyGeneration = null;
      let w = worker(data, browser, start);
      const stale = { ...packet('already-evicted', null), actions: [{ date, action: 'posts' }] };
      const result = await w.send(stale, otherTab);
      assert.equal(result.ok, true);
      assert.equal(w.data[date].linkedin.consumeSec, 7);
      assert.equal(w.data[date].linkedin.posts, 1);
      assert.equal(typeof result.generation, 'string');
      assert.deepEqual(w.data._receipts, []);
      w = worker(w.data, browser, w.now);
      assert.equal((await w.send({ type: 'snapshot' })).generation, result.generation);
      const attempts = [];
      const t = await tracker(browser, { url: otherTab.url, forward(message) {
        if (message.type === 'ingest') attempts.push(structuredClone(message));
        return w.send(message, otherTab);
      } });
      await drain();
      t.input(); t.setNow(5000); w.advance(5000);
      await t.tick(); await drain();
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].generation, result.generation);
      assert.equal(w.data[date].linkedin.consumeSec, 12);
      assert.equal(w.data[date].linkedin.posts, 1);
      assert.equal(w.data._receipts.length, 1);
      assert.deepEqual(w.errors, []);
    }
  });

  test(`${browser}: boot and daily preparation preserve full journals with recognized generations`, async () => {
    const receipts = Array.from({ length: 512 }, (_, n) => `known-${n}`);
    const session = {};
    const first = worker({ _access: { linkedin: { remainingMs: 300000 } }, _historyGeneration: 'recognized-window', _receipts: receipts, [date]: { linkedin: { consumeSec: 7 } } }, browser, start, { session });
    assert.equal((await first.send({ type: 'snapshot' })).generation, 'recognized-window');
    assert.deepEqual(first.data._receipts, receipts);
    const w = worker(first.data, browser, first.now, { session });
    assert.equal((await w.send(packet('known-0', 'recognized-window'), otherTab)).generation, 'recognized-window');
    assert.equal(w.data[date].linkedin.consumeSec, 7);
    assert.deepEqual(w.data._receipts, receipts);
    w.advance(86400000);
    assert.equal((await w.send({ type: 'snapshot' })).generation, 'recognized-window');
    assert.deepEqual(w.data._receipts, receipts);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: partial null-generation journals retain recognized retries and normal first-window ingestion`, async () => {
    const w = worker({ _access: { linkedin: { remainingMs: 300000 } }, _receipts: ['known-partial'], [date]: { linkedin: { consumeSec: 7 } } }, browser, start);
    assert.equal((await w.send(packet('known-partial', null), otherTab)).generation, null);
    assert.equal(w.data[date].linkedin.consumeSec, 7);
    assert.deepEqual(w.data._receipts, ['known-partial']);
    assert.equal((await w.send(packet('fresh-partial', null), otherTab)).generation, null);
    assert.equal(w.data[date].linkedin.consumeSec, 8);
    assert.deepEqual(w.data._receipts, ['known-partial', 'fresh-partial']);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: a warm first window can reach capacity but its next worker load invalidates ambiguous null deliveries`, async () => {
    const session = {};
    const first = worker({ _access: { linkedin: { remainingMs: 300000 } }, _receipts: Array.from({ length: 511 }, (_, n) => `warm-${n}`) }, browser, start, { session });
    assert.equal((await first.send({ type: 'snapshot' })).generation, null);
    const last = packet('warm-boundary', null);
    assert.equal((await first.send(last, otherTab)).generation, null);
    assert.equal((await first.send(last, otherTab)).generation, null);
    assert.equal(first.data[date].linkedin.consumeSec, 1);
    assert.equal(first.data._receipts.length, 512);
    const w = worker(first.data, browser, first.now, { session });
    const result = await w.send(packet('ambiguous-retry', null), otherTab);
    assert.equal(result.ok, true);
    assert.equal(typeof result.generation, 'string');
    assert.equal(w.data[date].linkedin.consumeSec, 1);
    assert.deepEqual(w.data._receipts, []);
    assert.equal((await w.send(last, otherTab)).generation, result.generation);
    assert.equal(w.data[date].linkedin.consumeSec, 1);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: a retry crossing midnight after generation validation cannot replay a full legacy journal`, async () => {
    const data = { _access: { linkedin: { remainingMs: 300000 } }, _receipts: Array.from({ length: 511 }, (_, n) => `midnight-${n}`) };
    let w, crossMidnight = false;
    const storage = {
      async get(keys) {
        if (crossMidnight && Array.isArray(keys) && keys.includes('_access')) {
          crossMidnight = false;
          w.advance(2000);
        }
        const selected = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(selected.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    };
    w = worker(data, browser, new Date(2026, 9, 11, 23, 59, 59).getTime(), { localStorage: storage });
    const retry = { ...packet('midnight-retry', null), segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'posts' }] };
    assert.equal((await w.send(retry, otherTab)).generation, null);
    assert.equal(data._receipts.length, 512);
    crossMidnight = true;
    const response = await w.send(retry, otherTab);
    assert.equal(response.ok, true);
    assert.equal(typeof response.generation, 'string');
    assert.equal(data[date].linkedin.consumeSec, 5);
    assert.equal(data[date].linkedin.posts, 1);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: failed legacy retirement retries before generation validation without crediting the stale packet`, async () => {
    const receipts = Array.from({ length: 512 }, (_, n) => `failed-legacy-${n}`);
    const w = worker({ _access: { linkedin: { remainingMs: 300000, expiresAt: 0, date } }, _receipts: receipts, [date]: { linkedin: { consumeSec: 7 } } }, browser, start);
    const stale = packet('already-evicted-before-failure', null);
    w.failWrites = true;
    assert.equal((await w.send(stale, otherTab)).ok, false);
    assert.equal(w.data[date].linkedin.consumeSec, 7);
    assert.equal(w.data._historyGeneration, undefined);
    assert.deepEqual(w.data._receipts, receipts);
    w.failWrites = false;
    const result = await w.send(stale, otherTab);
    assert.equal(result.ok, true);
    assert.equal(typeof result.generation, 'string');
    assert.equal(w.data[date].linkedin.consumeSec, 7);
    assert.deepEqual(w.data._receipts, []);
    assert.equal(w.errors.length, 2);
  });
}
