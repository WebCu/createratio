'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const { worker, popupSender } = require('./background-harness.js');
const start = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(start));
const byteSize = data => Object.entries(data).reduce((sum, [key, value]) => sum + new TextEncoder().encode(key + JSON.stringify(value)).length, 0);

function quotaStorage(data, capacity = byteSize(data)) {
  const attempts = [], removals = [], state = { error: null, failRemove: false, capacity, quotaError: new Error('QUOTA_BYTES quota exceeded') };
  const storage = {
    async get(keys) {
      return Object.fromEntries((keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      attempts.push(structuredClone(values));
      if (state.error) throw state.error;
      if (byteSize({ ...data, ...values }) > state.capacity) throw state.quotaError;
      Object.assign(data, structuredClone(values));
    },
    async remove(keys) {
      if (state.failRemove) throw new Error('Remove failed');
      removals.push([...keys]);
      for (const key of keys) delete data[key];
    }
  };
  return { storage, state, attempts, removals };
}
function storedHistory(generation) {
  return {
    settings: { trackedSites: ['x'], intentionHistoryEnabled: true },
    _access: { x: { remainingMs: 300000, expiresAt: 0, date } },
    _intentions: [{ site: 'x', reason: 'Write a reply and leave the feed.', requestedAt: start }],
    _receipts: ['already-recorded'], _websiteTimeEnabled: true,
    [date]: { x: { consumeSec: 100, posts: 2 }, retired: { consumeSec: 1000 } },
    ['_websiteTime:' + date]: { 'example.test': 100 },
    ...(generation === undefined ? {} : { _historyGeneration: generation })
  };
}
function oldPacket(generation) {
  return { type: 'ingest', site: 'x', id: 'queued-before-clear', generation, segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'posts' }] };
}

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: first clear reclaims full storage with its generation in one batch and rejects pre-clear packets`, async () => {
    const data = storedHistory(), before = structuredClone(data), q = quotaStorage(data);
    if (browser === 'browser') q.state.quotaError = Object.assign(new Error('Storage capacity exceeded'), { name: 'QuotaExceededError' });
    const w = worker(data, browser, start, { localStorage: q.storage });
    const cleared = await w.send({ type: 'clear-history' }, popupSender);
    assert.equal(cleared.ok, true);
    assert.equal(typeof cleared.generation, 'string');
    assert.equal(data._historyGeneration, cleared.generation);
    assert.equal(q.attempts.filter(values => Object.hasOwn(values, '_historyGeneration')).length, 2);
    assert.equal(data[date], undefined); assert.equal(data['_websiteTime:' + date], undefined);
    for (const key of ['settings', '_access', '_intentions', '_receipts', '_websiteTimeEnabled']) assert.deepEqual(data[key], before[key]);
    const restarted = worker(data, browser, start, { localStorage: q.storage });
    assert.equal((await restarted.send(oldPacket())).generation, cleared.generation);
    assert.equal(data[date], undefined);
    q.state.capacity = Infinity;
    assert.equal((await restarted.send({ ...oldPacket(cleared.generation), id: 'fresh' })).ok, true);
    assert.equal(data[date].x.posts, 1); assert.equal(data[date].x.consumeSec, 5);
  });
}

test('Chromium 154 native quota error reclaims history and persists the reset generation', async () => {
  const data = storedHistory(), before = structuredClone(data), q = quotaStorage(data);
  q.state.quotaError = new Error('Resource::kQuotaBytes quota exceeded');
  const w = worker(data, 'chrome', start, { localStorage: q.storage });
  const cleared = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(cleared.ok, true); assert.equal(typeof cleared.generation, 'string');
  assert.equal(q.attempts.filter(values => Object.hasOwn(values, '_historyGeneration')).length, 2);
  assert.equal(data[date], undefined); assert.equal(data['_websiteTime:' + date], undefined);
  for (const key of ['settings', '_access', '_intentions', '_receipts', '_websiteTimeEnabled']) assert.deepEqual(data[key], before[key]);
  const restarted = worker(data, 'chrome', start, { localStorage: q.storage });
  assert.equal((await restarted.send(oldPacket())).generation, cleared.generation);
  assert.equal(data[date], undefined); assert.equal(data['_websiteTime:' + date], undefined);
});

test('generic generation failures, including unrelated quota wording, do not delete history', async () => {
  for (const message of ['Storage unavailable', 'Unable to query quota information', 'Resource::kQuotaBytes quota inspection failed']) {
    const data = storedHistory(), before = structuredClone(data), q = quotaStorage(data);
    q.state.error = new Error(message);
    const result = await worker(data, 'chrome', start, { localStorage: q.storage }).send({ type: 'clear-history' }, popupSender);
    assert.equal(result.ok, false); assert.equal(result.error, message);
    assert.deepEqual(data, before); assert.deepEqual(q.removals, []);
  }
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: worker replacement after the reclaim/reset batch but before cleanup cannot restore old packets`, async () => {
    const data = storedHistory('old'), before = structuredClone(data), q = quotaStorage(data);
    q.state.failRemove = true;
    const result = await worker(data, browser, start, { localStorage: q.storage }).send({ type: 'clear-history' }, popupSender);
    assert.equal(result.ok, false); assert.equal(result.error, 'Remove failed');
    assert.notEqual(data._historyGeneration, 'old');
    assert.equal(typeof data._historyGeneration, 'string');
    assert.deepEqual(data[date], {}); assert.deepEqual(data['_websiteTime:' + date], {});
    for (const key of ['settings', '_access', '_intentions', '_receipts', '_websiteTimeEnabled']) assert.deepEqual(data[key], before[key]);
    q.state.failRemove = false;
    const restarted = worker(data, browser, start, { localStorage: q.storage });
    const response = await restarted.send(oldPacket('old'));
    assert.equal(response.generation, data._historyGeneration);
    assert.deepEqual(data[date], {}); assert.deepEqual(data['_websiteTime:' + date], {});
    assert.equal((await restarted.send({ type: 'clear-history' }, popupSender)).ok, true);
    assert.equal(data[date], undefined); assert.equal(data['_websiteTime:' + date], undefined);
  });
}

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: failed quota cleanup resets enabled website time at clear, without replaying its checkpoint`, async () => {
    const data = storedHistory('old'), before = structuredClone(data), q = quotaStorage(data);
    const w = worker(data, browser, start, { localStorage: q.storage });
    w.grantWebsitePermissions(); w.activate('https://example.test/');
    assert.equal((await w.send({ type: 'snapshot' })).websiteTimeEnabled, true);
    w.advance(2000); q.state.failRemove = true;
    const cleared = await w.send({ type: 'clear-history' }, popupSender);
    assert.equal(cleared.ok, false); assert.equal(cleared.error, 'Remove failed');
    assert.notEqual(data._historyGeneration, 'old');
    assert.deepEqual(data['_websiteTime:' + date], {});
    q.state.failRemove = false; q.state.capacity = Infinity;
    w.advance(3000); w.alarm('website-time');
    const snapshot = await w.send({ type: 'snapshot' });
    assert.equal(snapshot.ok, true); assert.equal(snapshot.websiteTimeEnabled, true);
    assert.deepEqual(data['_websiteTime:' + date], { 'example.test': 3 });
    assert.deepEqual(data[date], {});
    for (const key of ['settings', '_access', '_intentions', '_receipts', '_websiteTimeEnabled']) assert.deepEqual(data[key], before[key]);
  });
}

test('website-time restart failure never replaces the original clear error', async () => {
  const data = storedHistory('old'), before = structuredClone(data), q = quotaStorage(data);
  const originalGet = q.storage.get;
  let resetReads = 0;
  q.storage.get = async keys => {
    if (keys === '_websiteTimeEnabled' && data._historyGeneration !== 'old') {
      resetReads++;
      throw new Error('Checkpoint restart failed');
    }
    return originalGet(keys);
  };
  const w = worker(data, 'chrome', start, { localStorage: q.storage });
  w.grantWebsitePermissions(); w.activate('https://example.test/');
  await w.send({ type: 'snapshot' });
  w.advance(2000); q.state.failRemove = true;
  const result = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(resetReads, 1);
  assert.equal(result.ok, false); assert.equal(result.error, 'Remove failed');
  for (const key of ['settings', '_access', '_intentions', '_receipts', '_websiteTimeEnabled']) assert.deepEqual(data[key], before[key]);
});

test('failed reclaim/reset batch preserves old history and generation until a successful retry', async () => {
  const data = storedHistory('old'), before = structuredClone(data), q = quotaStorage(data);
  const originalSet = q.storage.set;
  let generationAttempts = 0;
  q.storage.set = async values => {
    if (Object.hasOwn(values, '_historyGeneration') && ++generationAttempts === 2) throw new Error('Storage unavailable');
    return originalSet(values);
  };
  const w = worker(data, 'chrome', start, { localStorage: q.storage });
  const result = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(result.ok, false); assert.equal(result.error, 'Storage unavailable');
  assert.deepEqual(data, before); assert.deepEqual(q.removals, []);
  q.storage.set = originalSet;
  const cleared = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(cleared.ok, true); assert.notEqual(cleared.generation, 'old');
  await w.send(oldPacket('old')); assert.equal(data[date], undefined);
});

test('quota recovery reports failure when preserved metadata still leaves no space for a reset token', async () => {
  const data = storedHistory(); data[date] = {}; data['_websiteTime:' + date] = {};
  const before = structuredClone(data), q = quotaStorage(data);
  const w = worker(data, 'chrome', start, { localStorage: q.storage });
  const result = await w.send({ type: 'clear-history' }, popupSender);
  assert.equal(result.ok, false); assert.match(result.error, /QUOTA_BYTES/);
  assert.deepEqual(data, before); assert.deepEqual(q.removals, []);
  q.state.capacity += 128;
  assert.equal((await w.send({ type: 'clear-history' }, popupSender)).ok, true);
  assert.equal(typeof data._historyGeneration, 'string');
});

test('failed cleanup keeps the surviving history size cache aligned with the emptied records', async () => {
  const older = '2026-10-10', data = { [older]: { value: 'x'.repeat(60) }, [date]: { value: 'x'.repeat(60) } };
  const q = quotaStorage(data);
  const core = { ...C, localDate: () => date, recentDates: count => C.recentDates(count, new Date(start)) };
  const history = require('../background/history.js').create(q.storage, core, 170);
  await history.prepare();
  q.state.failRemove = true;
  await assert.rejects(history.clear('new-generation'), /Remove failed/);
  assert.deepEqual(data[older], {}); assert.deepEqual(data[date], {});
  q.state.failRemove = false; q.state.capacity = Infinity;
  await history.save({ [date]: { value: 'y'.repeat(120) } });
  assert.deepEqual(data[older], {}, 'empty older keys must not be evicted using their pre-clear sizes');
  assert.equal(data[date].value.length, 120); assert.deepEqual(q.removals, []);
});
