'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeWorker, worker, gate, popupSender } = require('../tests/background-harness.js');
const C = require('../../core/core.js');

test('queued timestamps retain their captured date after the timezone changes', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'UTC';
    const start = Date.UTC(2026, 9, 11, 23, 59, 50),
      date = C.localDate(new Date(start));
    const packet = {
      type: 'ingest',
      id: 'timezone-change',
      site: 'x',
      segments: [{ date, mode: 'consume', start, end: start + 5000, sec: 5 }],
      actions: [{ date, action: 'replies', at: start + 1000 }]
    };
    process.env.TZ = 'Asia/Tokyo';
    assert.notEqual(C.localDate(new Date(start)), date);
    const w = worker({ _access: { x: { remainingMs: 300000 } } }, 'chrome', start + 10000);
    const result = await w.send(packet);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(w.data[date].x.consumeSec, 5);
    assert.equal(w.data[date].x.replies, 1);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('fractional intervals immediately after midnight preserve their captured bucket', async () => {
  const midnight = new Date(2026, 9, 12).getTime(),
    date = C.localDate(new Date(midnight));
  const w = worker({ _access: { x: { remainingMs: 300000 } } }, 'chrome', midnight + 1000);
  const result = await w.send({
    type: 'ingest',
    id: 'fractional-midnight',
    site: 'x',
    segments: [{ date, mode: 'consume', start: midnight, end: midnight + 0.5, sec: 0.0005 }],
    actions: []
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(w.data[date].x.consumeSec, 0.0005);
});

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: duration commands accept explicit session and wait preferences and default to session time`, async () => {
    const w = worker({}, browser);
    for (const [preference, minutes] of [
      [undefined, 2],
      ['accessMinutes', 3],
      ['waitMinutes', 4]
    ]) {
      const message = { type: 'access-duration', minutes, ...(preference === undefined ? {} : { preference }) };
      assert.equal((await w.send(message, popupSender)).ok, true);
      assert.equal(w.data.settings[preference || 'accessMinutes'], minutes);
    }
    const saved = structuredClone(w.data.settings);
    for (const preference of ['unsupported', '', null, false, {}, []]) {
      assert.deepEqual(await w.send({ type: 'access-duration', preference, minutes: 5 }, popupSender), {
        ok: false,
        error: 'Unsupported preference'
      });
      assert.deepEqual(w.data.settings, saved);
    }
    assert.deepEqual(w.errors, []);
  });
  test(`${browser}: malformed commands are deliberate refusals, not worker failures`, async () => {
    const w = worker({}, browser);
    for (const message of [null, undefined, [], true, { type: 1 }, { type: [] }, {}]) {
      const result = await w.send(message);
      assert.deepEqual(result, { ok: false, error: 'Invalid message' });
    }
    assert.equal(w.errors.length, 0);
    assert.equal(w.data.settings, undefined);
  });

  test(`${browser}: only native top-level extension pages may explicitly apply an update`, async () => {
    const w = worker({}, browser);
    for (const page of ['popup', 'settings', 'dashboard']) {
      assert.deepEqual(
        await w.send(
          { type: 'update-apply' },
          { id: 'test-extension', frameId: 0, url: 'chrome-extension://test-extension/' + page + '.html' }
        ),
        { ok: true, applied: false }
      );
    }
    assert.deepEqual(await w.send({ type: 'update-apply' }, gate('x')), { ok: true, applied: false });
    for (const sender of [
      { id: 'test-extension', frameId: 0, tab: { id: 1 }, url: 'https://x.com/home' },
      { id: 'test-extension', frameId: 1, url: 'chrome-extension://test-extension/settings.html' },
      { id: 'another-extension', frameId: 0, url: 'chrome-extension://test-extension/settings.html' }
    ])
      assert.equal((await w.send({ type: 'update-apply' }, sender)).ok, false);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: malformed delivery items cannot mutate recorded activity`, async () => {
    const w = activeWorker({}, browser);
    for (const [field, error] of [
      ['segments', 'Invalid time segment'],
      ['actions', 'Action not supported on this site']
    ]) {
      const packet = { type: 'ingest', site: 'x', id: 'packet', segments: [], actions: [], [field]: [null] };
      assert.deepEqual(await w.send(packet), { ok: false, error, retryable: false });
    }
    assert.equal(w.errors.length, 0);
    assert.equal(w.data._receipts, undefined);
  });

  test(`${browser}: snapshots expose normalized history without rewriting saved records`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(),
      date = C.localDate(new Date(now));
    for (const day of [null, 'bad', [], 3]) {
      const w = worker({ [date]: day }, browser, now);
      const result = await w.send({ type: 'snapshot' }, popupSender);
      assert.equal(result.ok, true);
      assert.deepEqual(result.day, {});
      assert.deepEqual(w.data[date], day);
      assert.deepEqual(w.errors, []);
    }
    const day = { retired: { createSec: 2, consumeSec: '10', note: 'keep' } };
    const w = worker({ [date]: structuredClone(day) }, browser, now);
    const result = await w.send({ type: 'snapshot' }, popupSender);
    assert.equal(result.day.retired.createSec, 2);
    assert.equal(result.day.retired.consumeSec, 0);
    assert.equal(result.day.retired.note, 'keep');
    assert.deepEqual(w.data[date], day);
  });

  test(`${browser}: restoration cannot grant an oversized session or an impossible wait`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    const entries = [
      { remainingMs: 1e20, expiresAt: 0 },
      { expiresAt: now + 241 * 60000 },
      { readyAt: now + C.ACCESS_LIMITS.maxMinutes * 60000 + 1 }
    ];
    for (const entry of entries) {
      const w = worker({ _access: { x: entry } }, browser, now);
      const state = await w.send({ type: 'access-status' });
      assert.equal(state.access.x.remainingMs, 0);
      assert.equal(state.access.x.readyAt, null);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      assert.equal(
        w.rules.some(rule => rule.id === 101),
        false
      );
      assert.equal(w.errors.length, 0);
    }
  });

  test(`${browser}: malformed day envelopes and null settings cannot crash access recovery`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(),
      date = C.localDate(new Date(now));
    for (const day of [null, [], 'broken']) {
      const w = worker({ settings: { allowAboveGoal: true }, [date]: day }, browser, now);
      const result = await w.send({ type: 'access-status' });
      assert.equal(result.ok, true);
      assert.equal(result.access.x.goalAllowed, false);
      assert.equal(result.access.x.remainingMs, 0);
      assert.deepEqual(w.errors, []);
    }
    const w = worker({ settings: null }, browser, now);
    assert.equal((await w.send({ type: 'snapshot' }, popupSender)).ok, true);
    assert.equal((await w.send({ type: 'access-status' })).ok, true);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: missing website-time permission is a refusal, not a worker failure`, async () => {
    const w = worker({}, browser);
    const result = await w.send({ type: 'website-time-setting', enabled: true }, popupSender);
    assert.deepEqual(result, { ok: false, error: 'Allow the browser permissions to track all websites.' });
    assert.equal(w.data._websiteTimeEnabled, undefined);
    assert.deepEqual(w.errors, []);
    assert.equal((await w.send({ type: 'snapshot' }, popupSender)).websiteTimeEnabled, false);
  });

  test(`${browser}: malformed selections recover to Off and can be repaired by explicit choices`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(),
      date = C.localDate(new Date(now));
    for (const trackedSites of [null, 'prefix-x-suffix', 'x', {}, { x: true }, true, false, 0, 1]) {
      const settings = {
        trackedSites,
        accessMinutes: 12,
        nudgeEnabled: true,
        unknown: 'keep',
        siteOverrides: { x: { accessMinutes: 2 } }
      };
      const day = { x: { consumeSec: 10 } },
        intentions = [{ site: 'retired', reason: 'Legacy reason', requestedAt: 0 }];
      const websiteKey = '_websiteTime:' + date;
      const w = worker(
        {
          settings: structuredClone(settings),
          [date]: structuredClone(day),
          _intentions: structuredClone(intentions),
          [websiteKey]: { 'saved.test': 7 },
          _access: { x: { remainingMs: 120000 }, linkedin: { readyAt: now + 60000 } }
        },
        browser,
        now
      );
      const snapshot = await w.send({ type: 'snapshot' }, popupSender);
      assert.equal(snapshot.ok, true);
      assert.deepEqual(snapshot.settings.trackedSites, []);
      for (const site of ['x', 'linkedin']) {
        assert.equal(snapshot.access[site].enabled, false);
        assert.equal(snapshot.access[site].remainingMs, 0);
        assert.equal(snapshot.access[site].readyAt, null);
      }
      assert.deepEqual(w.data._access, {});
      assert.deepEqual(w.data.settings, settings);
      assert.equal(
        (
          await w.send({
            type: 'ingest',
            site: 'x',
            id: 'ignored',
            segments: [{ date, mode: 'consume', sec: 5 }],
            actions: []
          })
        ).ok,
        true
      );
      assert.equal(
        (
          await w.send(
            { type: 'access-begin', site: 'x', reason: 'Reply to my colleague about the launch, then leave.' },
            gate('x')
          )
        ).ok,
        true
      );
      assert.deepEqual(w.data[date], day);
      assert.equal(w.data._receipts, undefined);
      assert.deepEqual(w.data._intentions, intentions);
      assert.deepEqual(w.data[websiteKey], { 'saved.test': 7 });
      const disabled = await w.send({ type: 'tracking', site: 'linkedin', enabled: false }, popupSender);
      assert.equal(disabled.ok, true);
      assert.deepEqual(disabled.settings.trackedSites, []);
      const repaired = await w.send({ type: 'tracking', site: 'x', enabled: true }, popupSender);
      assert.equal(repaired.ok, true);
      assert.deepEqual(repaired.settings.trackedSites, ['x']);
      assert.equal(repaired.access.x.enabled, true);
      assert.equal(repaired.access.x.remainingMs, 0);
      assert.equal(repaired.access.x.readyAt, null);
      assert.equal(repaired.access.x.sessionMinutes, 2);
      assert.equal(repaired.access.linkedin.enabled, false);
      assert.deepEqual(w.data.settings, { ...C.DEFAULT_SETTINGS, ...settings, trackedSites: ['x'] });
      assert.deepEqual(w.errors, []);
    }
  });

  test(`${browser}: partial saved selections preserve explicit string choices without rewriting them`, async () => {
    const settings = { trackedSites: ['x', null, {}, false, 1, 'retired'] };
    const w = worker({ settings: structuredClone(settings) }, browser);
    const result = await w.send({ type: 'snapshot' }, popupSender);
    assert.equal(result.ok, true);
    assert.deepEqual(result.settings.trackedSites, ['x', 'retired']);
    assert.equal(result.access.x.enabled, true);
    assert.equal(result.access.linkedin.enabled, false);
    assert.deepEqual(w.data.settings, settings);
  });

  test(`${browser}: creation admits only exact vetted HTTPS hosts, not access-only hosts`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(),
      date = C.localDate(new Date(now));
    const candidates = [
      ['x', 'https://x.com/home', true],
      ['x', 'https://www.x.com/home', true],
      ['linkedin', 'https://linkedin.com/feed', true],
      ['linkedin', 'https://www.linkedin.com/feed', true],
      ['x', 'http://x.com/home', false],
      ['x', 'http://www.x.com/home', false],
      ['x', 'https://twitter.com/home', false],
      ['x', 'https://www.twitter.com/home', false],
      ['x', 'https://mobile.x.com/home', false],
      ['x', 'https://x.com.evil.test/home', false],
      ['linkedin', 'http://linkedin.com/feed', false],
      ['linkedin', 'https://mobile.linkedin.com/feed', false],
      ['linkedin', 'https://x.com/home', false],
      ['x', 'https://linkedin.com/feed', false]
    ];
    for (const [site, url, allowed] of candidates) {
      const w = worker({ _access: { x: { remainingMs: 300000 }, linkedin: { remainingMs: 300000 } } }, browser, now);
      const packet = {
        type: 'ingest',
        site,
        id: 'valid-packet',
        segments: [{ date, mode: 'consume', sec: 5 }],
        actions: []
      };
      const result = await w.send(packet, { id: 'test-extension', tab: { id: 1 }, frameId: 0, url });
      assert.equal(result.ok, allowed, url);
      if (allowed) {
        assert.equal(result.day[site].consumeSec, 5, url);
        assert.deepEqual(w.data._receipts, ['valid-packet'], url);
      } else {
        assert.equal(result.error, 'Unsupported sender', url);
        assert.equal(w.data._receipts, undefined, url);
        assert.equal(w.data[date], undefined, url);
      }
      assert.deepEqual(w.errors, [], url);
    }
  });

  test(`${browser}: popup sharing can read only today's creation totals`, async () => {
    const date = C.localDate(),
      day = { x: { createSec: 120, consumeSec: 60, posts: 1 } };
    const w = worker(
      {
        [date]: day,
        ['_websiteTime:' + date]: { 'private.example': 600 },
        _intentions: [{ site: 'x', reason: 'Private intention', requestedAt: Date.now() }]
      },
      browser
    );
    const reply = await w.send({ type: 'history', kind: 'ratio', range: 'today' }, popupSender);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.days, { [date]: day });
    for (const kind of ['ratio', 'websites'])
      for (const range of ['today', 'week', 'month']) {
        if (kind === 'ratio' && range === 'today') continue;
        assert.equal((await w.send({ type: 'history', kind, range }, popupSender)).ok, false, `${kind} ${range}`);
      }
    for (const sender of [
      { ...popupSender, frameId: 1 },
      { ...popupSender, url: popupSender.url + '?embedded' },
      gate('x'),
      { ...popupSender, url: 'https://x.com/home', tab: { id: 1 } }
    ]) {
      assert.equal((await w.send({ type: 'history', kind: 'ratio', range: 'today' }, sender)).ok, false);
    }
    assert.equal((await w.send({ type: 'access-history-list' }, popupSender)).ok, false);
    assert.deepEqual(w.errors, []);
  });

  test(`${browser}: command authority stays specific to each domain boundary`, async () => {
    const w = worker({}, browser);
    const framedPopup = { ...popupSender, frameId: 1 };
    for (const message of [
      { type: 'tracking', site: 'x', enabled: false },
      { type: 'access-duration', minutes: 10 },
      { type: 'access-goal-setting', enabled: true },
      { type: 'access-history-setting', enabled: true }
    ])
      assert.equal((await w.send(message, framedPopup)).ok, false);
    assert.equal((await w.send({ type: 'history' }, gate('x'))).ok, false);
    assert.equal((await w.send({ type: 'access-history-list' }, popupSender)).ok, false);
    assert.equal(
      (
        await w.send(
          { type: 'ingest', site: 'x', segments: [], actions: [] },
          { id: 'other', tab: { id: 1 }, frameId: 0, url: 'https://x.com/home' }
        )
      ).ok,
      false
    );
    assert.equal(w.data.settings, undefined);
    assert.equal(w.errors.length, 0);
  });
}

test('incoming site fields accept every vetted site and reject only unknown or malformed site IDs', async () => {
  const integrations = require('../../sites/index.js');
  const date = C.localDate();
  const unknown = ['retired', 'constructor', '__proto__', 'X', '', null, 42];
  const w = worker({}, 'chrome');
  for (const { id, gated, hosts } of integrations.sites) {
    assert.equal((await w.send({ type: 'tracking', site: id, enabled: true }, popupSender)).ok, true, id);
    const ingest = { type: 'ingest', id: 'packet-' + id, site: id, segments: [], actions: [] };
    const sender = { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://' + hosts[0] + '/' };
    assert.equal((await w.send(ingest, sender)).ok, true, id);
    if (!gated) continue;
    const duration = { type: 'access-duration', site: id, minutes: 7 };
    assert.equal((await w.send(duration, popupSender)).ok, true, id);
    assert.equal((await w.send({ type: 'access-cancel', site: id }, gate(id))).ok, true, id);
  }
  for (const site of unknown) {
    const label = String(site);
    assert.equal((await w.send({ type: 'tracking', site, enabled: true }, popupSender)).ok, false, label);
    assert.equal((await w.send({ type: 'access-duration', site, minutes: 7 }, popupSender)).ok, false, label);
    assert.equal((await w.send({ type: 'access-cancel', site }, gate(site))).ok, false, label);
    assert.equal((await w.send({ type: 'access-end', site }, popupSender)).ok, false, label);
    const ingest = { type: 'ingest', id: 'packet-' + label, site, segments: [], actions: [] };
    assert.equal(
      (await w.send(ingest, { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://x.com/' })).ok,
      false,
      label
    );
  }
  assert.equal(w.data[date], undefined);
});

const deliveryNow = new Date(2026, 9, 11, 12).getTime(),
  deliveryDate = C.localDate(new Date(deliveryNow));
function deliveryPacket(overrides = {}) {
  return {
    type: 'ingest',
    id: 'delivery',
    site: 'x',
    segments: [{ date: deliveryDate, mode: 'consume', sec: 5 }],
    actions: [{ date: deliveryDate, action: 'posts' }],
    ...overrides
  };
}
function deliveryWorker(data = {}) {
  return worker({ _access: { x: { remainingMs: 300000 } }, ...data }, 'chrome', deliveryNow);
}
const segment = fields => [{ date: deliveryDate, mode: 'consume', sec: 5, ...fields }];
const limits = C.DELIVERY_LIMITS;

test('delivery packet refusals name the broken rule and record nothing', async () => {
  for (const [overrides, error] of [
    [{ id: 7 }, 'Invalid packet'],
    [{ id: 'i'.repeat(limits.maxIdLength + 1) }, 'Invalid packet'],
    [{ segments: {} }, 'Invalid packet'],
    [{ actions: 'posts' }, 'Invalid packet'],
    [{ segments: Array.from({ length: limits.maxItems + 1 }, () => segment({ sec: 1 })[0]) }, 'Invalid packet'],
    [
      { actions: Array.from({ length: limits.maxItems + 1 }, () => ({ date: deliveryDate, action: 'posts' })) },
      'Invalid packet'
    ],
    [{ segments: segment({ date: '2026-02-30' }) }, 'Invalid time segment'],
    [{ segments: segment({ mode: 'neutral' }) }, 'Invalid time segment'],
    [{ segments: segment({ sec: 0 }) }, 'Invalid time segment'],
    [{ segments: segment({ sec: '5' }) }, 'Invalid time segment'],
    [{ segments: segment({ sec: limits.maxSeconds + 1 }) }, 'Invalid time segment'],
    [{ segments: [...segment({ sec: limits.maxSeconds }), ...segment({ sec: 1 })] }, 'Time packet too large'],
    [{ segments: segment({ start: 1000 }) }, 'Invalid time interval'],
    [{ segments: segment({ start: -1000, end: 4000 }) }, 'Invalid time interval'],
    [{ segments: segment({ start: 1000, end: 1000 }) }, 'Invalid time interval'],
    [{ segments: segment({ start: 1000, end: 7000 }) }, 'Invalid time interval'],
    [{ actions: [{ date: deliveryDate, action: 'connections' }] }, 'Action not supported on this site'],
    [{ actions: [{ date: 'today', action: 'posts' }] }, 'Action not supported on this site'],
    [{ actions: [{ date: deliveryDate, action: 'posts', at: -1 }] }, 'Invalid action time'],
    [{ actions: [{ date: deliveryDate, action: 'posts', at: '1' }] }, 'Invalid action time']
  ]) {
    const w = deliveryWorker();
    assert.deepEqual(
      await w.send(deliveryPacket(overrides)),
      { ok: false, error, retryable: false },
      JSON.stringify(overrides)
    );
    assert.equal(w.data._receipts, undefined);
    assert.equal(w.data[deliveryDate], undefined);
    assert.deepEqual(w.errors, []);
  }
});

test('delivery packets at their limits are recorded once', async () => {
  const w = deliveryWorker();
  const packet = deliveryPacket({
    id: 'i'.repeat(limits.maxIdLength),
    segments: [...segment({ start: 1000, end: 4000, sec: 3 }), ...segment({ sec: limits.maxSeconds - 3 })],
    actions: [{ date: deliveryDate, action: 'quotes', at: 0 }]
  });
  assert.equal((await w.send(packet)).ok, true);
  assert.equal((await w.send(packet)).ok, true);
  assert.equal(w.data[deliveryDate].x.consumeSec, limits.maxSeconds);
  assert.equal(w.data[deliveryDate].x.quotes, 1);
  assert.equal(w.data[deliveryDate].x.posts, 1);
  assert.deepEqual(w.data._receipts, [packet.id]);
});

test('stale or untracked delivery packets are acknowledged before their contents are checked', async () => {
  const malformed = deliveryPacket({ segments: segment({ sec: -1 }) });
  for (const [data, generation] of [
    [{ _historyGeneration: 'current' }, 'old'],
    [{ _historyGeneration: 'current' }, null],
    [{ _historyGeneration: 'current' }, undefined],
    [{}, 'old'],
    [{ settings: { trackedSites: [] } }, undefined]
  ]) {
    const w = deliveryWorker(data);
    const result = await w.send({ ...malformed, generation });
    assert.equal(result.ok, true, JSON.stringify({ data, generation, result }));
    assert.equal(result.generation, data._historyGeneration ?? null);
    assert.equal(w.data._receipts, undefined);
    assert.equal(w.data[deliveryDate], undefined);
  }
});

test('a delivery packet without a generation matches history that has none', async () => {
  for (const generation of [undefined, null]) {
    const w = deliveryWorker();
    assert.equal((await w.send(deliveryPacket({ generation }))).ok, true);
    assert.equal(w.data[deliveryDate].x.consumeSec, 5);
  }
  const w = deliveryWorker({ _historyGeneration: 'current' });
  assert.equal((await w.send(deliveryPacket({ generation: 'current' }))).ok, true);
  assert.equal(w.data[deliveryDate].x.consumeSec, 5);
});
