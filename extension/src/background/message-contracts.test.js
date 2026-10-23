'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeWorker, worker, gate, popupSender } = require('../tests/background-harness.js');
const C = require('../../core/core.js');

for (const browser of ['chrome', 'browser']) {
  test(`${browser}: malformed commands are deliberate refusals, not worker failures`, async () => {
    const w = worker({}, browser);
    for (const message of [null, undefined, [], true, { type: 1 }, { type: [] }, {}]) {
      const result = await w.send(message);
      assert.deepEqual(result, { ok: false, error: 'Invalid message' });
    }
    assert.equal(w.errors.length, 0);
    assert.equal(w.data.settings, undefined);
  });

  test(`${browser}: malformed delivery items cannot mutate recorded activity`, async () => {
    const w = activeWorker({}, browser);
    for (const [field, error] of [['segments', 'Invalid time segment'], ['actions', 'Action not supported on this site']]) {
      const packet = { type: 'ingest', site: 'x', id: 'packet', segments: [], actions: [], [field]: [null] };
      assert.deepEqual(await w.send(packet), { ok: false, error });
    }
    assert.equal(w.errors.length, 0);
    assert.equal(w.data._receipts, undefined);
  });

  test(`${browser}: snapshots expose normalized history without rewriting saved records`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(now));
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
      { readyAt: 1, requestExpiresAt: now + 365 * 86400000 },
      { readyAt: now + 60001, requestExpiresAt: now + 660001 },
      { readyAt: now - 1, requestExpiresAt: now + 600000 }
    ];
    for (const entry of entries) {
      const w = worker({ _access: { x: entry } }, browser, now);
      const state = await w.send({ type: 'access-status' });
      assert.equal(state.access.x.remainingMs, 0);
      assert.equal(state.access.x.readyAt, 0);
      assert.equal((await w.send({ type: 'access-open', site: 'x' }, gate('x'))).ok, false);
      assert.equal(w.rules.some(rule => rule.id === 101), false);
      assert.equal(w.errors.length, 0);
    }
  });

  test(`${browser}: malformed day envelopes and null settings cannot crash access recovery`, async () => {
    const now = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(now));
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
    const now = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(now));
    for (const trackedSites of [null, 'prefix-x-suffix', 'x', {}, { x: true }, true, false, 0, 1]) {
      const settings = { trackedSites, accessMinutes: 12, nudgeEnabled: true, unknown: 'keep', siteOverrides: { x: { accessMinutes: 2 } } };
      const day = { x: { consumeSec: 10 } }, intentions = [{ site: 'retired', reason: 'Legacy reason', requestedAt: 0 }];
      const websiteKey = '_websiteTime:' + date;
      const w = worker({ settings: structuredClone(settings), [date]: structuredClone(day), _intentions: structuredClone(intentions), [websiteKey]: { 'saved.test': 7 },
        _access: { x: { remainingMs: 120000 }, linkedin: { readyAt: now + 60000, requestExpiresAt: now + 660000 } } }, browser, now);
      const snapshot = await w.send({ type: 'snapshot' }, popupSender);
      assert.equal(snapshot.ok, true);
      assert.deepEqual(snapshot.settings.trackedSites, []);
      for (const site of ['x', 'linkedin']) {
        assert.equal(snapshot.access[site].enabled, false);
        assert.equal(snapshot.access[site].remainingMs, 0);
        assert.equal(snapshot.access[site].readyAt, 0);
      }
      assert.deepEqual(w.data._access, {});
      assert.deepEqual(w.data.settings, settings);
      assert.equal((await w.send({ type: 'ingest', site: 'x', id: 'ignored', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] })).ok, true);
      assert.equal((await w.send({ type: 'access-begin', site: 'x', reason: 'Reply to my colleague about the launch, then leave.' }, gate('x'))).ok, true);
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
      assert.equal(repaired.access.x.readyAt, 0);
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
    const now = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(now));
    const candidates = [
      ['x', 'https://x.com/home', true], ['x', 'https://www.x.com/home', true],
      ['linkedin', 'https://linkedin.com/feed', true], ['linkedin', 'https://www.linkedin.com/feed', true],
      ['x', 'http://x.com/home', false], ['x', 'http://www.x.com/home', false],
      ['x', 'https://twitter.com/home', false], ['x', 'https://www.twitter.com/home', false],
      ['x', 'https://mobile.x.com/home', false], ['x', 'https://x.com.evil.test/home', false],
      ['linkedin', 'http://linkedin.com/feed', false], ['linkedin', 'https://mobile.linkedin.com/feed', false],
      ['linkedin', 'https://x.com/home', false], ['x', 'https://linkedin.com/feed', false]
    ];
    for (const [site, url, allowed] of candidates) {
      const w = worker({ _access: { x: { remainingMs: 300000 }, linkedin: { remainingMs: 300000 } } }, browser, now);
      const packet = { type: 'ingest', site, id: 'valid-packet', segments: [{ date, mode: 'consume', sec: 5 }], actions: [] };
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
    const date = C.localDate(), day = { x: { createSec: 120, consumeSec: 60, posts: 1 } };
    const w = worker({ [date]: day, ['_websiteTime:' + date]: { 'private.example': 600 }, _intentions: [{ site: 'x', reason: 'Private intention', requestedAt: Date.now() }] }, browser);
    const reply = await w.send({ type: 'history', kind: 'ratio', range: 'today' }, popupSender);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.days, { [date]: day });
    for (const kind of ['ratio', 'websites']) for (const range of ['today', 'week', 'month']) {
      if (kind === 'ratio' && range === 'today') continue;
      assert.equal((await w.send({ type: 'history', kind, range }, popupSender)).ok, false, `${kind} ${range}`);
    }
    for (const sender of [{ ...popupSender, frameId: 1 }, { ...popupSender, url: popupSender.url + '?embedded' }, gate('x'), { ...popupSender, url: 'https://x.com/home', tab: { id: 1 } }]) {
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
    ]) assert.equal((await w.send(message, framedPopup)).ok, false);
    assert.equal((await w.send({ type: 'history' }, gate('x'))).ok, false);
    assert.equal((await w.send({ type: 'access-history-list' }, popupSender)).ok, false);
    assert.equal((await w.send({ type: 'ingest', site: 'x', segments: [], actions: [] }, { id: 'other', tab: { id: 1 }, frameId: 0, url: 'https://x.com/home' })).ok, false);
    assert.equal(w.data.settings, undefined);
    assert.equal(w.errors.length, 0);
  });
}
