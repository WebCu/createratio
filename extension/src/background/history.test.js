'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C3 = require('../../core/core.js');
const { DAYS, PREFIX, MAX_BYTES } = require('./history.js');
const { worker } = require('../tests/background-harness.js');
function harness(data = {}, limit = MAX_BYTES, initial = new Date(2026, 9, 31, 12).getTime()) {
  let now = initial;
  const reads = [], writes = [];
  const state = { quota: false, quotaError: null, failRemove: false, failSet: false, setError: null, quotaBytes: Infinity };
  const storage = {
    async get(keys) { reads.push(keys); return Object.fromEntries((keys === null ? Object.keys(data) : keys).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) {
      if (state.failSet) throw new Error('Storage unavailable');
      if (state.setError) throw state.setError;
      if (state.quota) { state.quota = false; throw state.quotaError || new Error('QUOTA_BYTES exceeded'); }
      const candidate = { ...data };
      for (const [key, value] of Object.entries(values)) {
        candidate[key] = value;
        const finalBytes = Object.entries(candidate).reduce((sum, [key, value]) => sum + new TextEncoder().encode(key + JSON.stringify(value)).length, 0);
        if (finalBytes > state.quotaBytes) throw new Error('QUOTA_BYTES exceeded');
      }
      writes.push(structuredClone(values)); Object.assign(data, structuredClone(values));
    },
    async remove(keys) { if (state.failRemove) throw new Error('Remove failed'); for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  const context = vm.createContext({ Date: Clock, TextEncoder, crypto });
  vm.runInContext(fs.readFileSync(require.resolve('./history.js'), 'utf8'), context);
  const history = context.ActivityHistory.create(storage, C3, limit);
  return { history, data, reads, writes, state, advanceDay(days = 1) { const date = new Date(now); date.setDate(date.getDate() + days); now = date.getTime(); } };
}
test('stored history prunes expired and invalid dates while reads select only the last 30 local days', async () => {
  assert.equal(DAYS, 30);
  const data = { settings: { trackedSites: [] }, _access: { x: { remainingMs: 100 } }, _receipts: ['retry'] };
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-31', '2026-11-01', '2026-11-31']) {
    data[date] = { x: { consumeSec: 5 } }; data[PREFIX + date] = { 'example.com': 5 };
  }
  const h = harness(data); await h.history.prepare();
  assert.deepEqual(Object.keys(data).sort(), ['settings', '_access', '_receipts', '2026-10-02', '2026-10-31', '2026-11-01', PREFIX + '2026-10-02', PREFIX + '2026-10-31', PREFIX + '2026-11-01'].sort());
  for (const kind of ['ratio', 'websites']) assert.deepEqual(Object.keys(await h.history.read(kind)), ['2026-10-02', '2026-10-31']);
  await h.history.save({ '2026-10-01': { x: { posts: 1 } } });
  assert.equal(data['2026-10-01'], undefined);
});
test('timezone rollback preserves saved history through worker replacement until selected dates catch up', async () => {
  const timezone = process.env.TZ, instant = Date.parse('2026-10-12T03:00:00Z'), date = '2026-10-12';
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/dashboard.html', frameId: 0 };
  const WebTime = require('./web-time.js');
  try {
    for (const browser of ['chrome', 'browser']) {
      process.env.TZ = 'Pacific/Auckland';
      const data = { settings: { trackedSites: [] }, [date]: { retired: { posts: 2, createSec: 300 } }, [PREFIX + date]: { 'saved.test': 120 } };
      const before = structuredClone(data), w = worker(data, browser, instant);
      assert.equal((await w.send({ type: 'snapshot' })).date, date);
      process.env.TZ = 'America/Los_Angeles';
      assert.equal((await w.send({ type: 'snapshot' })).date, '2026-10-11');
      assert.deepEqual(data[date], before[date]);
      assert.deepEqual(data[PREFIX + date], before[PREFIX + date]);
      const restarted = worker(data, browser, instant);
      for (const kind of ['ratio', 'websites']) {
        const response = await restarted.send({ type: 'history', kind, range: 'month' }, sender);
        assert.equal(response.ok, true);
        assert.equal(response.days[date], undefined);
      }
      assert.deepEqual(data[date], before[date]);
      assert.deepEqual(data[PREFIX + date], before[PREFIX + date]);
      restarted.advance(86400000);
      const ratio = await restarted.send({ type: 'history', kind: 'ratio', range: 'today' }, sender);
      const websites = await restarted.send({ type: 'history', kind: 'websites', range: 'today' }, sender);
      assert.deepEqual(ratio.days[date], before[date]);
      assert.deepEqual(websites.days[date], before[PREFIX + date]);
      assert.ok(C3.csv(ratio.days).includes(`${date},retired,0.000,300.000,2`));
      assert.ok(WebTime.csv(websites.days).includes(`${date},"saved.test",120.000`));
      assert.deepEqual(data.settings, before.settings);
      assert.deepEqual(w.errors, []);
      assert.deepEqual(restarted.errors, []);
    }
  } finally {
    if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
  }
});
test('calendar rollback preserves recorded totals and still prunes them once truly expired', async () => {
  const date = '2026-10-31', h = harness();
  await h.history.prepare();
  await h.history.recordCreation({ id: 'recorded', site: 'x', segments: [{ date, mode: 'create', sec: 5 }], actions: [{ date, action: 'posts' }] });
  await h.history.recordWebsiteTime('saved.test', [{ date, sec: 8 }]);
  const before = structuredClone(h.data);
  h.advanceDay(-46);
  for (const kind of ['ratio', 'websites']) assert.equal((await h.history.read(kind))[date], undefined);
  assert.deepEqual(h.data, before);
  const restarted = harness(h.data, MAX_BYTES, new Date(2026, 8, 15, 12).getTime());
  await restarted.history.prepare();
  assert.deepEqual(h.data, before);
  restarted.advanceDay(46);
  assert.equal((await restarted.history.read('ratio', 'today'))[date].x.posts, 1);
  assert.equal((await restarted.history.read('websites', 'today'))[date]['saved.test'], 8);
  restarted.advanceDay(29);
  await restarted.history.prepare();
  assert.deepEqual(h.data, before);
  restarted.advanceDay();
  await restarted.history.prepare();
  assert.deepEqual(h.data, { _receipts: ['recorded'] });
});
test('new creation and website segments cannot add future credit to saved or missing days', async () => {
  const date = '2026-10-31', future = '2026-11-01', data = { [future]: { x: { posts: 2, createSec: 7 } }, [PREFIX + future]: { 'saved.test': 8 } }, h = harness(data);
  const before = structuredClone(data), packet = { id: 'mixed', site: 'x', segments: [
    { date, mode: 'create', sec: 3 }, { date: future, mode: 'create', sec: 100 }, { date: '2026-11-02', mode: 'consume', sec: 100 }, { date: '2026-10-01', mode: 'create', sec: 100 }
  ], actions: [{ date, action: 'posts' }, { date: future, action: 'quotes' }, { date: '2026-11-02', action: 'posts' }, { date: '2026-10-01', action: 'posts' }] };
  await h.history.prepare();
  await h.history.recordCreation(packet);
  await h.history.recordWebsiteTime('saved.test', [{ date, sec: 3 }, { date: future, sec: 100 }, { date: '2026-11-02', sec: 100 }, { date: '2026-10-01', sec: 100 }]);
  assert.deepEqual(data[date].x, { ...C3.emptyStats(), posts: 1, createSec: 3 });
  assert.deepEqual(data[PREFIX + date], { 'saved.test': 3 });
  assert.deepEqual(data[future], before[future]);
  assert.deepEqual(data[PREFIX + future], before[PREFIX + future]);
  for (const ignored of ['2026-10-01', '2026-11-02']) {
    assert.equal(data[ignored], undefined);
    assert.equal(data[PREFIX + ignored], undefined);
  }
  assert.deepEqual(data._receipts, ['mixed']);
  h.advanceDay();
  await h.history.prepare();
  await h.history.recordCreation(packet);
  assert.deepEqual(data[future], before[future]);
  assert.equal((await h.history.read('websites', 'today'))[future]['saved.test'], 8);
});
test('legacy migration retains future-dated domains across replacement without double counting', async () => {
  const date = '2026-11-01', data = { _websiteTime: { [date]: { 'legacy.test': 8, 'shared.test': 4 }, '2026-10-01': { expired: 100 }, '2026-11-31': { invalid: 100 } },
    [PREFIX + date]: { 'current.test': 9, 'shared.test': 10 } }, h = harness(data);
  await h.history.prepare();
  const expected = { [PREFIX + date]: { 'legacy.test': 8, 'current.test': 9, 'shared.test': 10 } };
  assert.deepEqual(data, expected);
  const restarted = harness(data);
  assert.equal((await restarted.history.read('websites'))[date], undefined);
  assert.deepEqual(data, expected);
  restarted.advanceDay();
  assert.deepEqual(structuredClone((await restarted.history.read('websites', 'today'))[date]), expected[PREFIX + date]);
  assert.deepEqual(data, expected);
});
test('legacy website history migrates once, keeps retained values, and does not double count after restart', async () => {
  const data = { _websiteTime: { '2000-01-01': { old: 100 }, '2026-10-02': { 'a.test': 5 }, '2026-10-31': { 'a.test': 8 } }, [PREFIX + '2026-10-31']: { 'a.test': 10 }, _websiteTimeEnabled: true };
  const h = harness(data); await h.history.prepare();
  assert.equal(data._websiteTime, undefined); assert.deepEqual(data[PREFIX + '2026-10-02'], { 'a.test': 5 });
  assert.deepEqual(data[PREFIX + '2026-10-31'], { 'a.test': 10 }); assert.equal(data._websiteTimeEnabled, true);
  await harness(data).history.prepare(); assert.deepEqual(data[PREFIX + '2026-10-31'], { 'a.test': 10 });
});
test('migration replaces the legacy object in the same write, avoiding temporary double storage near quota', async () => {
  const data = { _websiteTime: { '2000-01-01': { expired: 'x'.repeat(200) }, '2026-10-31': { 'a.test': 8 } } }, h = harness(data);
  h.state.quotaBytes = 300;
  await h.history.prepare();
  assert.equal(data._websiteTime, undefined); assert.deepEqual(data[PREFIX + '2026-10-31'], { 'a.test': 8 });
  assert.deepEqual(h.writes[0]._websiteTime, {}); assert.equal(Object.keys(h.writes[0])[0], '_websiteTime');
});
test('failed migration can be retried without losing the legacy copy', async () => {
  const data = { _websiteTime: { '2026-10-31': { 'a.test': 8 } } }, h = harness(data);
  h.state.failSet = true; await assert.rejects(h.history.prepare(), /unavailable/);
  assert.ok(data._websiteTime); h.state.failSet = false; await h.history.prepare();
  assert.deepEqual(data[PREFIX + '2026-10-31'], { 'a.test': 8 }); assert.equal(data._websiteTime, undefined);
});
test('routine reads fetch only selected date keys and maintenance runs once per date', async () => {
  const h = harness({ '2026-10-31': { retired: { posts: 1 } }, [PREFIX + '2026-10-31']: { 'a.test': 8 } });
  await h.history.prepare(); h.reads.length = 0;
  const today = await h.history.read('websites', 'today');
  assert.deepEqual(h.reads, [[PREFIX + '2026-10-31']]); assert.equal(today['2026-10-31']['a.test'], 8);
  await h.history.read('ratio', 'week'); assert.equal(h.reads[1].length, 7); assert.ok(h.reads[1].every(key => !key.startsWith(PREFIX)));
  await h.history.read('websites', 'month'); assert.equal(h.reads[2].length, 30);
});
test('midnight maintenance expires both kinds of history without a restart', async () => {
  const data = { '2026-10-02': { x: { posts: 1 } }, [PREFIX + '2026-10-02']: { 'a.test': 8 } }, h = harness(data);
  await h.history.prepare(); h.advanceDay(); await h.history.prepare(); assert.deepEqual(data, {});
});
test('storage cap removes whole oldest days first, preserving settings and current day', async () => {
  const data = { settings: { trackedSites: [] }, '2026-10-02': { x: { posts: 1 } }, [PREFIX + '2026-10-02']: { 'a.test': 8 }, '2026-10-30': { x: { posts: 2 } } };
  const h = harness(data, 110); await h.history.prepare();
  await h.history.save({ '2026-10-31': { x: { posts: 3 } }, [PREFIX + '2026-10-31']: { 'a.test': 9 } });
  assert.equal(data['2026-10-02'], undefined); assert.equal(data[PREFIX + '2026-10-02'], undefined);
  assert.equal(data['2026-10-31'].x.posts, 3); assert.equal(data[PREFIX + '2026-10-31']['a.test'], 9); assert.ok(data.settings);
});
test('actual browser quota failures evict an older day and retry the write', async () => {
  const data = { '2026-10-02': { x: { posts: 1 } } }, h = harness(data);
  await h.history.prepare(); h.state.quota = true;
  await h.history.save({ '2026-10-31': { x: { posts: 2 } } });
  assert.equal(data['2026-10-02'], undefined); assert.equal(data['2026-10-31'].x.posts, 2);
});
test('size and quota pressure can evict oldest future-dated whole days while protecting today', async () => {
  for (const pressure of ['size', 'quota']) {
    const date = '2026-10-31', future = '2026-11-01', later = '2026-11-02';
    const data = { settings: { trackedSites: [] }, [future]: { x: { posts: 2 } }, [PREFIX + future]: { 'a.test': 8 }, [later]: { x: { posts: 3 } } };
    const h = harness(data, pressure === 'size' ? 110 : MAX_BYTES);
    await h.history.prepare();
    assert.ok(data[future]); assert.ok(data[PREFIX + future]);
    h.state.quota = pressure === 'quota';
    await h.history.save({ [date]: { x: { posts: 1 } } });
    assert.equal(data[future], undefined);
    assert.equal(data[PREFIX + future], undefined);
    assert.deepEqual(data[later], { x: { posts: 3 } });
    assert.deepEqual(data[date], { x: { posts: 1 } });
    assert.deepEqual(data.settings, { trackedSites: [] });
  }
});
test('an oversized current day fails visibly rather than deleting today or settings', async () => {
  const data = { '2026-10-31': { x: { posts: 2 } }, settings: { nudgeEnabled: true } }, h = harness(data, 80);
  await h.history.prepare();
  await assert.rejects(h.history.save({ '2026-10-31': { value: 'x'.repeat(100) } }), /Export and clear/);
  assert.equal(data['2026-10-31'].x.posts, 2); assert.equal(data.settings.nudgeEnabled, true);
});
test('clear removes only activity totals and leaves deduplication, permissions, settings and access intact', async () => {
  const data = { '2026-10-31': { retired: { posts: 2 } }, [PREFIX + '2026-10-31']: { 'a.test': 9 }, _websiteTime: {}, settings: {}, _access: { x: {} }, _websiteTimeEnabled: true, _receipts: ['retry'] };
  const h = harness(data); await h.history.clear();
  assert.deepEqual(data, { settings: {}, _access: { x: {} }, _websiteTimeEnabled: true, _receipts: ['retry'] });
  await h.history.save({ '2026-10-31': { x: { posts: 1 } } }); assert.equal(data['2026-10-31'].x.posts, 1);
});
test('creation recording owns retained totals, quote credit and receipt deduplication', async () => {
  const date = '2026-10-31', data = { settings: { trackedSites: ['x'] } }, h = harness(data);
  await h.history.prepare();
  const packet = { id: 'creation', site: 'x', segments: [
    { date, mode: 'create', sec: 2 }, { date, mode: 'consume', sec: 5 },
    { date: '2026-10-01', mode: 'consume', sec: 100 }
  ], actions: [{ date, action: 'quotes' }, { date: '2026-10-01', action: 'posts' }] };
  await h.history.recordCreation(packet);
  await h.history.recordCreation(packet);
  assert.deepEqual(data[date].x, { ...C3.emptyStats(), createSec: 2, consumeSec: 5, posts: 1, quotes: 1 });
  assert.deepEqual(data._receipts, ['creation']);
  assert.equal(data['2026-10-01'], undefined);
  assert.deepEqual(data.settings, { trackedSites: ['x'] });
});
test('failed creation recording leaves both totals and receipts unchanged until retry', async () => {
  const date = '2026-10-31', data = { [date]: { x: { consumeSec: 3 } }, _receipts: ['prior'] }, h = harness(data);
  await h.history.prepare();
  const before = structuredClone(data);
  const packet = { id: 'retry', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] };
  h.state.failSet = true;
  await assert.rejects(h.history.recordCreation(packet), /Storage unavailable/);
  assert.deepEqual(data, before);
  h.state.failSet = false;
  await h.history.recordCreation(packet);
  assert.equal(data[date].x.consumeSec, 8);
  assert.deepEqual(data._receipts, ['prior', 'retry']);
});
test('website recording owns date keys and accumulates repeated domain segments separately from creation', async () => {
  const date = '2026-10-31', data = { [date]: { x: { posts: 1 } } }, h = harness(data);
  await h.history.recordWebsiteTime('example.com', [
    { date, sec: 2 }, { date, sec: 3 }, { date: '2026-10-01', sec: 100 }
  ]);
  await h.history.recordWebsiteTime('other.test', [{ date, sec: 4 }]);
  assert.deepEqual(data[PREFIX + date], { 'example.com': 5, 'other.test': 4 });
  assert.deepEqual(data[date], { x: { posts: 1 } });
  assert.equal(data[PREFIX + '2026-10-01'], undefined);
  assert.equal(data._receipts, undefined);
});
test('creation accrual normalizes known stats without coercion and preserves other saved history', async () => {
  const date = '2026-10-31', retired = { consumeSec: 20, posts: 2, oldField: 'saved' };
  for (const invalid of ['10', -10, NaN, Infinity, -Infinity, null, true, {}, []]) {
    const data = { [date]: { x: { consumeSec: invalid, posts: invalid, quotes: invalid, createSec: 4, unknown: { kept: true } }, retired }, _receipts: ['prior'] };
    const h = harness(data);
    await h.history.prepare();
    await h.history.recordCreation({ id: 'fresh', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'quotes' }] });
    assert.deepEqual(data[date].x, { ...C3.emptyStats(), consumeSec: 5, createSec: 4, posts: 1, quotes: 1, unknown: { kept: true } });
    assert.deepEqual(data[date].retired, retired);
    assert.deepEqual(data._receipts, ['prior', 'fresh']);
  }
});
test('website accrual treats invalid stored totals as zero while preserving other domains', async () => {
  const date = '2026-10-31';
  for (const invalid of ['10', -10, NaN, Infinity, -Infinity, null, true, {}, []]) {
    const data = { [PREFIX + date]: { 'example.com': invalid, 'retained.test': 12 } }, h = harness(data);
    await h.history.recordWebsiteTime('example.com', [{ date, sec: 2 }, { date, sec: 3 }]);
    assert.deepEqual(data[PREFIX + date], { 'example.com': 5, 'retained.test': 12 });
  }
});
test('website accrual replaces malformed day collections without touching good days or creation history', async () => {
  const date = '2026-10-31', older = PREFIX + '2026-10-30';
  for (const malformed of ['broken', 12, true, null, [9, 10]]) {
    const data = { [PREFIX + date]: malformed, [older]: { 'saved.test': 7 }, [date]: { retired: { posts: 3 } } }, h = harness(data);
    await h.history.recordWebsiteTime('example.com', [{ date, sec: 5 }]);
    assert.deepEqual(data[PREFIX + date], { 'example.com': 5 });
    assert.deepEqual(data[older], { 'saved.test': 7 });
    assert.deepEqual(data[date], { retired: { posts: 3 } });
  }
});
test('creation accrual repairs malformed days and site stats without discarding good records', async () => {
  const date = '2026-10-31', retired = { posts: 3, oldField: 'saved' };
  for (const malformed of ['broken', 12, true, null, [9, 10]]) {
    for (const day of [malformed, { x: malformed, retired }]) {
      const data = { [date]: day, '2026-10-30': { retired } }, h = harness(data);
      await h.history.prepare();
      await h.history.recordCreation({ id: 'fresh', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'posts' }] });
      assert.deepEqual(data[date].x, { ...C3.emptyStats(), consumeSec: 5, posts: 1 });
      if (day && typeof day === 'object' && !Array.isArray(day)) assert.deepEqual(data[date].retired, retired);
      assert.deepEqual(data['2026-10-30'], { retired });
    }
  }
});
test('worker retires malformed receipt journals before validating stale generations without changing totals', async () => {
  const date = '2026-10-31', start = new Date(2026, 9, 31, 12).getTime();
  const malformed = ['prior', {}, 7, true, ['prior', null], ['prior', 7], ['duplicate', 'duplicate'], ['x'.repeat(101)], Array(1), Array.from({ length: 513 }, (_, n) => `prior-${n}`)];
  for (const browser of ['chrome', 'browser']) for (const generation of [null, 'known-window']) for (const receipts of malformed) {
    const data = { _access: { x: { remainingMs: 300000, expiresAt: 0, date } }, _historyGeneration: generation, _receipts: receipts, [date]: { x: { consumeSec: 7, posts: 2 }, retired: { posts: 3 } } };
    const w = worker(data, browser, start);
    const pending = { type: 'ingest', id: 'lost-retry', generation, site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'posts' }] };
    const response = await w.send(pending);
    assert.equal(response.ok, true);
    assert.equal(typeof response.generation, 'string');
    assert.notEqual(response.generation, generation);
    assert.deepEqual(data[date], { x: { consumeSec: 7, posts: 2 }, retired: { posts: 3 } });
    assert.deepEqual(data._receipts, []);
    const restarted = worker(data, browser, start);
    assert.equal((await restarted.send(pending)).generation, response.generation);
    assert.equal((await restarted.send({ ...pending, id: 'fresh', generation: response.generation })).ok, true);
    assert.equal(data[date].x.consumeSec, 12);
    assert.equal(data[date].x.posts, 3);
    assert.deepEqual(data[date].retired, { posts: 3 });
    assert.deepEqual(data._receipts, ['fresh']);
    assert.deepEqual(w.errors, []);
    assert.deepEqual(restarted.errors, []);
  }
});
test('worker retires malformed saved generations even when their journals are otherwise valid', async () => {
  const date = '2026-10-31', start = new Date(2026, 9, 31, 12).getTime();
  for (const browser of ['chrome', 'browser']) for (const generation of ['', 0, 7, false, true, {}, []]) {
    const data = { _historyGeneration: generation, _receipts: ['known'], [date]: { x: { consumeSec: 7 } } }, w = worker(data, browser, start);
    const response = await w.send({ type: 'ingest', id: 'lost-retry', generation, site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] });
    assert.equal(response.ok, true);
    assert.equal(typeof response.generation, 'string');
    assert.notEqual(response.generation, generation);
    assert.deepEqual(data[date], { x: { consumeSec: 7 } });
    assert.deepEqual(data._receipts, []);
    assert.equal((await w.send({ type: 'snapshot' })).generation, response.generation);
    assert.deepEqual(w.errors, []);
  }
});
test('ordinary save recovery matches quota wording while clear keeps its narrower reset guard', async () => {
  for (const message of ['Unable to query quota information', 'Resource::kQuotaBytes quota inspection failed']) {
    const data = { '2026-10-02': { retired: { posts: 2 } }, '2026-10-31': { x: { consumeSec: 7 } } }, h = harness(data);
    await h.history.prepare();
    const before = structuredClone(data);
    h.state.setError = new Error(message);
    await assert.rejects(h.history.clear('new-generation'), error => error.message === message);
    assert.deepEqual(data, before);
    await assert.rejects(h.history.save({ '2026-10-31': { x: { consumeSec: 12 } } }), /Export and clear/);
    assert.equal(data['2026-10-02'], undefined);
    assert.deepEqual(data['2026-10-31'], before['2026-10-31']);
    assert.equal(data._historyGeneration, undefined);
  }
});
test('ordinary save errors without quota wording preserve history even with a quota error name', async () => {
  for (const error of [new Error('Storage unavailable'), Object.assign(new Error('Storage capacity exceeded'), { name: 'QuotaExceededError' })]) {
    const data = { '2026-10-02': { retired: { posts: 2 } }, '2026-10-31': { x: { consumeSec: 7 } } }, h = harness(data);
    await h.history.prepare();
    const before = structuredClone(data);
    h.state.setError = error;
    await assert.rejects(h.history.save({ '2026-10-31': { x: { consumeSec: 12 } } }), failure => failure === error);
    assert.deepEqual(data, before);
  }
});
test('failed malformed-journal retirement preserves totals and retries before accepting stale deliveries', async () => {
  const date = '2026-10-31', start = new Date(2026, 9, 31, 12).getTime();
  for (const browser of ['chrome', 'browser']) {
    const data = { _access: { x: { remainingMs: 300000, expiresAt: 0, date } }, _receipts: { ambiguous: true }, _historyGeneration: 'old', [date]: { x: { consumeSec: 7 } }, [PREFIX + date]: { 'saved.test': 8 } };
    const before = structuredClone(data), w = worker(data, browser, start);
    const pending = { type: 'ingest', id: 'retry', generation: 'old', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] };
    w.failWrites = true;
    assert.equal((await w.send(pending)).ok, false);
    assert.deepEqual(data, before);
    w.failWrites = false;
    const response = await w.send(pending);
    assert.equal(response.ok, true);
    assert.notEqual(response.generation, 'old');
    assert.deepEqual(data[date], before[date]);
    assert.deepEqual(data[PREFIX + date], before[PREFIX + date]);
    assert.deepEqual(data._receipts, []);
    assert.equal(w.errors.length, 2);
  }
});
test('null and partial legacy journals keep their generation and deduplication', async () => {
  const date = '2026-10-31';
  for (const generation of [undefined, null, 'recognized']) for (const receipts of [undefined, null, [], ['', 'prior']]) {
    const data = { [date]: { x: { consumeSec: 7 } } };
    if (generation !== undefined) data._historyGeneration = generation;
    if (receipts !== undefined) data._receipts = receipts;
    const before = structuredClone(data), h = harness(data);
    await h.history.prepare();
    assert.deepEqual(data, before);
    const packet = { id: '', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] };
    await h.history.recordCreation(packet);
    await h.history.recordCreation(packet);
    assert.equal(data[date].x.consumeSec, receipts?.includes('') ? 7 : 12);
    assert.equal(data._historyGeneration, generation);
    assert.deepEqual(data._receipts, receipts?.includes('') ? receipts : ['']);
  }
});
test('worker accrues numeric creation and website totals from malformed saved numbers without coercion', async () => {
  const date = '2026-10-31', start = new Date(2026, 9, 31, 12).getTime();
  for (const browser of ['chrome', 'browser']) {
    const data = { _access: { x: { remainingMs: 300000, expiresAt: 0, date } }, _websiteTimeEnabled: true,
      [date]: { x: { consumeSec: '10', posts: '10', quotes: '10', createSec: 2, unknown: 'saved' }, retired: { posts: 3 } },
      [PREFIX + date]: { 'example.test': '10', 'retained.test': 8 } };
    const w = worker(data, browser, start);
    w.grantWebsitePermissions();
    w.activate('https://example.test/');
    const initial = await w.send({ type: 'snapshot' });
    assert.equal(initial.websiteTimeEnabled, true);
    w.advance(5000);
    const response = await w.send({ type: 'ingest', id: 'fresh', generation: initial.generation, site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'quotes' }] });
    assert.equal(response.ok, true);
    assert.deepEqual(response.day.x, { ...C3.emptyStats(), consumeSec: 5, createSec: 2, posts: 1, quotes: 1, unknown: 'saved' });
    assert.deepEqual(response.day.retired, { posts: 3 });
    assert.deepEqual(data[PREFIX + date], { 'example.test': 5, 'retained.test': 8 });
    assert.deepEqual(data._receipts, ['fresh']);
    assert.deepEqual(w.errors, []);
  }
});
test('quota wording retries an ordinary save after evicting an older whole day', async () => {
  for (const error of [new Error('Browser quota exceeded'), new Error('Resource::kQuotaBytes quota exceeded'), new Error('QUOTA_BYTES_PER_ITEM quota exceeded')]) {
    const data = { '2026-10-02': { retired: { posts: 2 } }, [PREFIX + '2026-10-02']: { 'saved.test': 7 } }, h = harness(data);
    await h.history.prepare();
    h.state.quota = true; h.state.quotaError = error;
    await h.history.save({ '2026-10-31': { x: { posts: 1 } } });
    assert.equal(data['2026-10-02'], undefined);
    assert.equal(data[PREFIX + '2026-10-02'], undefined);
    assert.equal(data['2026-10-31'].x.posts, 1);
  }
});
test('history reads return usable day maps for malformed restored envelopes without rewriting storage', async () => {
  const date = '2026-10-31', older = '2026-10-30';
  const WebTime = require('./web-time.js');
  for (const malformed of [null, [], [7], 'broken', 12, true]) {
    const data = { _historyMeta: malformed, _websiteTime: malformed, [date]: malformed, [PREFIX + date]: malformed,
      [older]: { retired: { consumeSec: 8, unknown: 'saved' } }, [PREFIX + older]: { 'saved.test': 9 }, unrelated: { saved: true } };
    const before = structuredClone(data), h = harness(data);
    const ratio = await h.history.read('ratio'), websites = await h.history.read('websites');
    assert.deepEqual(structuredClone(ratio[date]), {});
    assert.deepEqual(structuredClone(websites[date]), {});
    assert.deepEqual(structuredClone(ratio[older].retired), { consumeSec: 8, unknown: 'saved' });
    assert.equal(C3.aggregate(ratio[date]).consumeSec, 0);
    assert.ok(C3.csv(ratio).includes(`${older},retired,8.000`));
    assert.deepEqual(WebTime.summarize(websites), [['saved.test', 9]]);
    assert.ok(WebTime.csv(websites).includes(`${older},"saved.test",9.000`));
    delete before._websiteTime;
    assert.deepEqual(data, before);
    await h.history.recordCreation({ id: 'fresh', site: 'x', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] });
    await h.history.recordWebsiteTime('example.test', [{ date, sec: 5 }]);
    assert.equal(data[date].x.consumeSec, 5);
    assert.deepEqual(data[PREFIX + date], { 'example.test': 5 });
    assert.deepEqual(data._historyMeta, malformed);
    assert.deepEqual(data[older], before[older]);
    assert.deepEqual(data[PREFIX + older], before[PREFIX + older]);
    assert.deepEqual(data.unrelated, before.unrelated);
  }
});
test('creationDay supplies non-mutating usable rows for snapshots and history reads', async () => {
  const date = '2026-10-31', day = { x: { consumeSec: '10', posts: -2, createSec: 4, unknown: { saved: true } },
    retired: { consumeSec: 8, posts: 3, retiredField: 'kept' }, future_site: { futureField: 12 }, null_site: null, array_site: [7], string_site: 'broken', number_site: 7 };
  const data = { [date]: day, _historyMeta: ['unknown'] }, before = structuredClone(data), h = harness(data);
  const normalized = h.history.creationDay(day);
  assert.deepEqual(structuredClone(normalized.x), { consumeSec: 0, posts: 0, createSec: 4, unknown: { saved: true } });
  assert.deepEqual(structuredClone(normalized.retired), { consumeSec: 8, posts: 3, retiredField: 'kept' });
  assert.deepEqual(structuredClone(normalized.future_site), { futureField: 12 });
  for (const site of ['null_site', 'array_site', 'string_site', 'number_site']) assert.deepEqual(structuredClone(normalized[site]), {});
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
  assert.deepEqual(data, before);
  const ratio = await h.history.read('ratio', 'today');
  assert.deepEqual(structuredClone(ratio[date]), structuredClone(normalized));
  assert.deepEqual(data, before);
  assert.equal(C3.aggregate(ratio[date]).consumeSec, 8);
  assert.ok(C3.csv(ratio).includes(`${date},retired,8.000`));
  for (const malformed of [undefined, null, [], [7], 'broken', 12, true]) assert.deepEqual(structuredClone(h.history.creationDay(malformed)), {});
});
test('website history reads normalize invalid totals without rewriting saved domain records', async () => {
  const date = '2026-10-31', day = { 'saved.test': 12.5, 'zero.test': 0, 'string.test': '10', 'negative.test': -2,
    'nan.test': NaN, 'infinity.test': Infinity, 'null.test': null, 'array.test': [7], 'object.test': { unknown: 'kept' }, 'boolean.test': true };
  const data = { [PREFIX + date]: day, _historyMeta: { unknown: 'kept' } }, before = structuredClone(data), h = harness(data);
  const websites = await h.history.read('websites', 'today');
  assert.deepEqual(structuredClone(websites[date]), { 'saved.test': 12.5, 'zero.test': 0, 'string.test': 0, 'negative.test': 0,
    'nan.test': 0, 'infinity.test': 0, 'null.test': 0, 'array.test': 0, 'object.test': 0, 'boolean.test': 0 });
  assert.deepEqual(data, before);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(require('./web-time.js').summarize(websites), [['saved.test', 12.5]]);
});
test('legacy website restoration preserves good domains alongside malformed or partial date records', async () => {
  const date = '2026-10-31', older = '2026-10-30';
  for (const malformed of [null, [], 'broken', 12, true]) {
    const data = { _websiteTime: { [date]: { 'legacy.test': 8 }, [older]: { 'legacy.test': 6, 'shared.test': 4 } },
      [PREFIX + date]: malformed, [PREFIX + older]: { 'current.test': 9, 'shared.test': 10 }, [date]: { retired: { posts: 3 } } }, h = harness(data);
    await h.history.prepare();
    assert.deepEqual(data[PREFIX + date], { 'legacy.test': 8 });
    assert.deepEqual(data[PREFIX + older], { 'legacy.test': 6, 'current.test': 9, 'shared.test': 10 });
    assert.deepEqual(data[date], { retired: { posts: 3 } });
    assert.equal(data._websiteTime, undefined);
    const before = structuredClone(data);
    await harness(data).history.prepare();
    assert.deepEqual(data, before);
  }
});
test('calendar retention handles month ends, leap days and daylight saving transitions', async () => {
  for (const [now, first] of [[new Date(2026, 2, 9, 12), '2026-02-08'], [new Date(2024, 2, 1, 12), '2024-02-01'], [new Date(2026, 10, 2, 12), '2026-10-04']]) {
    const h = harness({}, MAX_BYTES, now.getTime());
    assert.equal(h.history.retained(first), true);
    const older = new Date(first + 'T12:00:00'); older.setDate(older.getDate() - 1);
    assert.equal(h.history.retained(C3.localDate(older)), false);
  }
});
