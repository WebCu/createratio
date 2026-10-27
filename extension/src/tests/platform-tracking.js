'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../core/core.js');
const { environment } = require('../../sites/test-support.js');
const Sites = require('../../sites/index.js');
const { tracker } = require('./content-harness.js');
const { worker, popupSender, unlock } = require('./background-harness.js');

function gatedPlatform({ id: site, url, neutral: neutralPath }) {
  for (const browser of ['chrome', 'browser']) {
    test(`${browser}: ${site} opts into the shared gated time and scrolling lifecycle`, async () => {
      const t = await tracker(browser, { url, fixture: ({ url, listen }) => environment(url, listen) });
      const consumed = () => t.packets.flatMap(packet => packet.segments).reduce((sum, segment) => sum + (segment.mode === 'consume' ? segment.sec : 0), 0);
      t.input(); t.setNow(5000); await t.tick();
      assert.equal(consumed(), 0);
      assert.equal(t.wheel(240).defaultPrevented, false, 'Off preserves native scrolling');
      const settings = { ...C.DEFAULT_SETTINGS, trackedSites: [site] };
      t.setSnapshot({ day: {}, settings }); await t.tick();
      assert.equal(consumed(), 0, 'enabling does not backfill activity');
      t.input(); t.setNow(10000); await t.tick();
      assert.equal(consumed(), 5);
      assert.equal(t.wheel(240).defaultPrevented, true);
      assert.equal(t.document.scrollingElement.scrollTop, 1120, 'shared default resistance halves movement');
      assert.equal(t.listenerCount('wheel'), 2);
      t.visible(false);
      assert.equal(t.listenerCount('wheel'), 1, 'hidden pages release the friction listener');
      const before = t.packets.length;
      t.setNow(15000); await t.tick();
      assert.equal(t.packets.length, before);
      t.visible(true); await t.tick();
      t.route(new URL(neutralPath, url).href, false);
      assert.equal(t.wheel(240).defaultPrevented, false, 'unsupported and messaging routes stay native');
      t.route(url, false);
      assert.equal(t.wheel(-240).defaultPrevented, true);
      assert.equal(t.document.scrollingElement.scrollTop, 1000);
      for (let cycle = 0; cycle < 10; cycle++) {
        t.setSnapshot({ day: {}, settings: C.DEFAULT_SETTINGS }); await t.tick();
        assert.equal(t.listenerCount('wheel'), 1);
        t.setSnapshot({ day: {}, settings }); await t.tick();
        assert.equal(t.listenerCount('wheel'), 2, 're-enabling never accumulates listeners');
      }
      t.setSnapshot({ day: {}, settings: C.DEFAULT_SETTINGS }); await t.tick();
      t.input(); t.setNow(20000); await t.tick();
      assert.equal(consumed(), 5);
      assert.equal(t.wheel(240).defaultPrevented, false);
      assert.deepEqual(t.warnings, []);
    });

    test(`${browser}: ${site} validates senders and actions, retains history and deduplicates deliveries`, async () => {
      const now = new Date(2026, 9, 11, 12).getTime(), date = C.localDate(new Date(now));
      const w = worker({}, browser, now);
      const sender = { id: 'test-extension', tab: { id: 1 }, frameId: 0, url };
      const packet = { type: 'ingest', id: site + '-packet', site, segments: [{ date, mode: 'consume', sec: 5 }], actions: [{ date, action: 'comments' }] };
      assert.equal((await w.send(packet, sender)).ok, true);
      assert.equal(w.data[date], undefined, 'new platforms do not record by default');
      const enabled = await w.send({ type: 'tracking', site, enabled: true }, popupSender);
      assert.equal(enabled.ok, true);
      assert.ok(enabled.settings.trackedSites.includes(site));
      assert.equal(enabled.access[site].remainingMs, 0, 'enabling starts blocked');
      assert.equal((await w.send(packet, sender)).ok, true);
      assert.equal(w.data[date], undefined, 'blocked sites cannot record measurements');
      await unlock(w, site);
      assert.ok(Sites.get(site).actions.includes('comments'));
      const unsupported = C.FIELDS.find(field => !field.endsWith('Sec') && !Sites.get(site).actions.includes(field));
      assert.ok(unsupported, 'fixture can test an undeclared action');
      for (const rejected of [
        { ...sender, url: url.replace('https:', 'http:') },
        { ...sender, url: 'https://' + new URL(url).hostname + '.untrusted.test/' },
        { ...sender, frameId: 1 },
        { ...sender, id: 'other-extension' }
      ]) assert.equal((await w.send(packet, rejected)).ok, false);
      assert.equal((await w.send({ ...packet, actions: [{ date, action: unsupported }] }, sender)).ok, false);
      assert.equal(w.data[date], undefined);
      for (let retry = 0; retry < 3; retry++) assert.equal((await w.send(packet, sender)).ok, true);
      assert.equal(w.data[date][site].consumeSec, 5);
      assert.equal(w.data[date][site].comments, 1);
      const recorded = structuredClone(w.data[date]);
      assert.match(C.csv({ [date]: recorded }), new RegExp(',' + site + ','));
      const disabled = await w.send({ type: 'tracking', site, enabled: false }, popupSender);
      assert.equal(disabled.ok, true);
      assert.ok(!disabled.settings.trackedSites.includes(site));
      assert.equal((await w.send({ ...packet, id: site + '-after-off' }, sender)).ok, true);
      assert.deepEqual(w.data[date], recorded);
      assert.deepEqual(w.errors, []);
    });
  }
}

module.exports = { gatedPlatform };
