'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const [name, field] of [
  ['Session time', 'accessMinutes'],
  ['Intention wait', 'waitMinutes']
])
  test(`Default ${name} reconciles after blur when another Settings tab saves`, async () => {
    const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, `Default ${name} after external save and blur`, async () => {
        const a = await browser.page(browser.origin + '/settings.html');
        const b = await browser.page(browser.origin + '/settings.html');
        for (const page of [a, b])
          await eventually(
            () => evaluate(browser, page.session, `!!document.querySelector("#${field}-default")`),
            'Settings renders'
          );
        await evaluate(browser, a.session, `document.querySelector("#${field}-default").focus()`);
        await evaluate(
          browser,
          b.session,
          `(() => {
          const input = document.querySelector('#${field}-default');
          input.value = '15'; input.dispatchEvent(new Event('change', { bubbles: true }));
        })()`
        );
        await eventually(
          () => evaluate(browser, b.session, '!!document.querySelector("#save-status").textContent'),
          'second tab saves'
        );
        await eventually(
          () =>
            evaluate(
              browser,
              a.session,
              `document.querySelector("#${field}-site-x").selectedOptions[0].textContent === "Default · 15 min"`
            ),
          'inherited rows receive saved default'
        );
        assert.equal(await evaluate(browser, a.session, 'document.activeElement.id'), `${field}-default`);
        await browser.cdp.send('Page.bringToFront', {}, a.session);
        await evaluate(browser, a.session, `document.querySelector("#${field}-default").blur()`);
        assert.equal(await evaluate(browser, a.session, `document.querySelector("#${field}-default").value`), '15');
        const inherited = await evaluate(
          browser,
          a.session,
          `Array.from(document.querySelectorAll('#site-settings select[id^="${field}-site-"]'), input => ({ value: input.value, label: input.selectedOptions[0].textContent }))`
        );
        assert.ok(inherited.length > 0);
        for (const row of inherited) assert.deepEqual(row, { value: 'default', label: 'Default · 15 min' });
        assert.deepEqual(browser.errors, []);
      });
    } finally {
      await browser.cleanup();
    }
  });

test('Website Intention wait reconciles after blur when another Settings tab saves', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'website Intention wait after external save and blur', async () => {
      const a = await browser.page(browser.origin + '/settings.html');
      const b = await browser.page(browser.origin + '/settings.html');
      for (const page of [a, b])
        await eventually(
          () => evaluate(browser, page.session, '!!document.querySelector("#waitMinutes-site-x")'),
          'Settings renders'
        );
      await evaluate(browser, a.session, 'document.querySelector("#waitMinutes-site-x").focus()');
      await evaluate(
        browser,
        b.session,
        `(() => {
        const input = document.querySelector('#waitMinutes-site-x');
        input.value = '30'; input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`
      );
      await eventually(
        () => evaluate(browser, a.session, '!document.querySelector("#wait-reset-x").hidden'),
        'first tab receives the website override'
      );
      assert.equal(await evaluate(browser, a.session, 'document.activeElement.id'), 'waitMinutes-site-x');
      await browser.cdp.send('Page.bringToFront', {}, a.session);
      await evaluate(browser, a.session, 'document.querySelector("#waitMinutes-site-x").blur()');
      assert.deepEqual(
        await evaluate(
          browser,
          a.session,
          '(input => ({ value: input.value, label: input.selectedOptions[0].textContent }))(document.querySelector("#waitMinutes-site-x"))'
        ),
        { value: '30', label: '30 min' }
      );
      assert.deepEqual(browser.errors, []);
    });
  } finally {
    await browser.cleanup();
  }
});

test('hidden Settings and access pages do not amplify active-budget writes', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  try {
    await withFailureArtifacts(browser, 'multi-document access refresh', async () => {
      const midday = new Date();
      midday.setHours(12, 0, 0, 0);
      await browser.setTime(midday.getTime());
      await evaluate(
        browser,
        browser.worker,
        `(async () => {
        globalThis.budgetWrites = 0;
        chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes._access) budgetWrites++; });
        await chrome.storage.local.set({ _access: { x: { remainingMs: 300000, expiresAt: 0, date: Core.localDate() } } });
      })()`
      );
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(
        () => evaluate(browser, settings.session, '!!document.querySelector("#track-x")'),
        'first Settings renders'
      );
      const otherSettings = await browser.page(browser.origin + '/settings.html');
      await eventually(
        () => evaluate(browser, otherSettings.session, '!!document.querySelector("#track-x")'),
        'second Settings renders'
      );
      const gate = await browser.page(browser.origin + '/blocked.html?site=linkedin');
      await eventually(
        () => evaluate(browser, gate.session, 'document.querySelector("#begin")?.disabled === false'),
        'LinkedIn access page renders'
      );
      const site = await browser.page('https://x.com/home');
      await eventually(
        () =>
          evaluate(
            browser,
            site.session,
            '!!document.querySelector("#synthetic-site") && document.hasFocus() && !document.hidden'
          ),
        'offline X document is focused'
      );
      for (const page of [settings, otherSettings, gate])
        assert.equal(await evaluate(browser, page.session, 'document.hidden'), true);
      await eventually(
        () =>
          evaluate(
            browser,
            browser.worker,
            'chrome.storage.local.get("_access").then(value => value._access.x.expiresAt > Date.now())'
          ),
        'active budget is running'
      );
      const result = await evaluate(
        browser,
        browser.worker,
        `(async () => {
        const before = budgetWrites, started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 2000));
        const window = await chrome.windows.getLastFocused(), [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
        return { writes: budgetWrites - before, elapsed: Date.now() - started, focused: window.focused, active: tab?.url };
      })()`
      );
      assert.equal(result.focused, true);
      assert.equal(result.active, 'https://x.com/home');
      assert.ok(result.writes <= 40, `hidden pages amplified writes: ${JSON.stringify(result)}`);
      console.log(
        `Refresh regression: ${result.writes} budget writes in ${result.elapsed}ms across three hidden extension pages`
      );
      assert.deepEqual(browser.errors, []);
    });
  } finally {
    await browser.cleanup();
  }
});
