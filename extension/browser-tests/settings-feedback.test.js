'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('Settings confirmations fit the viewport, fade out and leave failures visible', async t => {
  const { launch, evaluate, eventually, clickByRole, findByRole, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const page = await browser.page(browser.origin + '/settings.html');
  const inspect = source => evaluate(browser, page.session, source);
  const journey = (name, run) => t.test(name, () => withFailureArtifacts(browser, name, run));
  try {
    await eventually(() => inspect('!!document.querySelector("#track-x")'), 'Settings ready');
    for (const width of [1280, 768, 320]) {
      await journey(`confirmation stays compact and expires at ${width}px`, async () => {
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false }, page.session);
        await clickByRole(browser, page, 'switch', 'Limit & track on X');
        await eventually(() => inspect('!!document.querySelector("#save-status").textContent && getComputedStyle(document.querySelector(".settings-feedback")).opacity === "1"'), 'confirmation painted');
        const layout = await inspect(`(() => {
          const box = document.querySelector('.settings-feedback').getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, bottom: box.bottom, viewport: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
        })()`);
        assert.ok(layout.left >= 16 && layout.right <= layout.viewport - 16, JSON.stringify(layout));
        assert.ok(layout.width <= 520 && layout.bottom < layout.height, JSON.stringify(layout));
        assert.equal(layout.overflow, false);
        const control = await findByRole(browser, page, 'combobox', 'Session time for Default');
        await browser.cdp.send('DOM.focus', { backendNodeId: control.backendDOMNodeId }, page.session);
        assert.equal(await inspect('document.activeElement.id'), 'accessMinutes-default');
        assert.equal(await inspect('document.querySelector("#save-status").getAttribute("role")'), 'status');
        await eventually(() => inspect('document.querySelector("#save-status").hasAttribute("data-leaving")'), 'confirmation starts fading', 6000);
        assert.equal(await inspect('getComputedStyle(document.querySelector(".settings-feedback")).pointerEvents'), 'none');
        await eventually(() => inspect('document.querySelector("#save-status").textContent === "" && getComputedStyle(document.querySelector(".settings-feedback")).display === "none"'), 'confirmation removed');
        assert.equal(await inspect('document.activeElement.id'), 'accessMinutes-default', 'dismissal preserves keyboard focus');
      });
    }
    await journey('reduced motion removes the fade without preventing dismissal', async () => {
      await browser.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'forced-colors', value: 'active' }] }, page.session);
      await clickByRole(browser, page, 'switch', 'Limit & track on X');
      await eventually(() => inspect('!!document.querySelector("#save-status").textContent'), 'reduced-motion confirmation');
      assert.equal(await inspect('getComputedStyle(document.querySelector(".settings-feedback")).transitionDuration'), '0s');
      assert.equal(await inspect('getComputedStyle(document.querySelector(".settings-feedback")).outlineStyle'), 'solid');
      await eventually(() => inspect('document.querySelector("#save-status").textContent === ""'), 'reduced-motion confirmation removed', 6000);
    });
    await journey('a failed save stays visible past the confirmation deadline and clears on retry', async () => {
      await inspect(`(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime); let fail = true;
        chrome.runtime.sendMessage = message => {
          if (message.type === 'tracking' && fail) { fail = false; return Promise.resolve({ ok: false, error: 'Could not save. Try again.' }); }
          return send(message);
        };
      })()`);
      await clickByRole(browser, page, 'switch', 'Limit & track on X');
      await eventually(() => inspect('!document.querySelector("#error").hidden'), 'save error shown');
      await new Promise(resolve => setTimeout(resolve, 4500));
      assert.equal(await inspect('document.querySelector("#error").hidden'), false);
      assert.equal(await inspect('getComputedStyle(document.querySelector(".settings-feedback")).opacity'), '1');
      await clickByRole(browser, page, 'switch', 'Limit & track on X');
      await eventually(() => inspect('document.querySelector("#error").hidden && !!document.querySelector("#save-status").textContent'), 'successful retry replaces the error');
    });
    assert.deepEqual(browser.errors, []);
  } finally { await browser.cleanup(); }
});
