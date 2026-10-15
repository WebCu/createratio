'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('hidden Settings and access pages do not amplify active-budget writes', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  try {
    await withFailureArtifacts(browser, 'multi-document access refresh', async () => {
      const midday = new Date(); midday.setHours(12, 0, 0, 0);
      await browser.setTime(midday.getTime());
      await evaluate(browser, browser.worker, `(async () => {
        globalThis.budgetWrites = 0;
        chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes._access) budgetWrites++; });
        await chrome.storage.local.set({ _access: { x: { remainingMs: 300000, expiresAt: 0, date: C3.localDate() } } });
      })()`);
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => evaluate(browser, settings.session, '!!document.querySelector("#track-x")'), 'first Settings renders');
      const otherSettings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => evaluate(browser, otherSettings.session, '!!document.querySelector("#track-x")'), 'second Settings renders');
      const gate = await browser.page(browser.origin + '/blocked.html?site=linkedin');
      await eventually(() => evaluate(browser, gate.session, 'document.querySelector("#begin")?.disabled === false'), 'LinkedIn access page renders');
      const site = await browser.page('https://x.com/home');
      await eventually(() => evaluate(browser, site.session, '!!document.querySelector("#synthetic-site") && document.hasFocus() && !document.hidden'), 'offline X document is focused');
      for (const page of [settings, otherSettings, gate]) assert.equal(await evaluate(browser, page.session, 'document.hidden'), true);
      await eventually(() => evaluate(browser, browser.worker, 'chrome.storage.local.get("_access").then(value => value._access.x.expiresAt > Date.now())'), 'active budget is running');
      const result = await evaluate(browser, browser.worker, `(async () => {
        const before = budgetWrites, started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 2000));
        const window = await chrome.windows.getLastFocused(), [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
        return { writes: budgetWrites - before, elapsed: Date.now() - started, focused: window.focused, active: tab?.url };
      })()`);
      assert.equal(result.focused, true);
      assert.equal(result.active, 'https://x.com/home');
      assert.ok(result.writes <= 40, `hidden pages amplified writes: ${JSON.stringify(result)}`);
      console.log(`Refresh regression: ${result.writes} budget writes in ${result.elapsed}ms across three hidden extension pages`);
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
