'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('hidden creation trackers stop snapshot polling and synchronize when foregrounded', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'inactive tracker worker wakeups', async () => {
      await evaluate(browser, browser.worker, `(async () => {
        await chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS, trackedSites: [] } });
        globalThis.trackerSnapshots = 0;
        chrome.runtime.onMessage.addListener((message, sender) => {
          if (sender.tab && message.type === 'snapshot') trackerSnapshots++;
        });
      })()`);
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, 'document.readyState === "complete" && !!document.querySelector("#synthetic-site") && document.hasFocus() && !document.hidden'), 'disabled X page is ready');
      await eventually(() => evaluate(browser, browser.worker, 'trackerSnapshots > 0'), 'initial tracker preferences');
      const away = await browser.page('about:blank');
      await eventually(() => evaluate(browser, away.session, 'document.hasFocus()'), 'unrelated tab is focused');
      await eventually(() => evaluate(browser, site.session, 'document.hidden && !document.hasFocus()'), 'X tracker is hidden');
      const result = await evaluate(browser, browser.worker, `(async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        const before = trackerSnapshots;
        await new Promise(resolve => setTimeout(resolve, 6000));
        return { before, after: trackerSnapshots };
      })()`);
      assert.equal(result.after, result.before, 'a hidden tracker without pending activity must not poll the worker');
      await browser.cdp.send('Target.activateTarget', { targetId: site.targetId });
      await eventually(() => evaluate(browser, site.session, 'document.hasFocus() && !document.hidden'), 'X tracker returns to foreground');
      await eventually(() => evaluate(browser, browser.worker, `trackerSnapshots > ${result.after}`), 'foregrounding refreshes tracker preferences');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
