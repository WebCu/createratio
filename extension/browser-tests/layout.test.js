'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');

test('built extension keeps focused settings, narrow tasks and history readable', async t => {
  const { launch, evaluate, eventually, click, clickByRole, findByRole, openSettingsSection, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const pageAt = async (url, width) => {
    const page = await browser.page('about:blank');
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false }, page.session);
    await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'Math.random = () => 0;' }, page.session);
    await browser.cdp.send('Page.navigate', { url: browser.origin + url }, page.session);
    await eventually(() => inspect(page, 'document.readyState === "complete" && document.querySelector("#error")?.hidden'), 'extension document ready');
    return page;
  };
  const noOverflow = async page => {
    const sizes = await inspect(page, '({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth })');
    assert.ok(sizes.document <= sizes.width && sizes.body <= sizes.width, JSON.stringify(sizes));
  };
  const key = async (page, name, code, modifiers = 0) => {
    const details = { key: name, code: name === 'a' ? 'KeyA' : name, windowsVirtualKeyCode: code, modifiers };
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...details, ...(name === 'Enter' ? { text: '\r' } : {}) }, page.session);
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...details }, page.session);
  };
  const focusDuration = async (page, name) => {
    await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
    const node = await findByRole(browser, page, 'combobox', 'Session time for ' + name);
    await browser.cdp.send('DOM.focus', { backendNodeId: node.backendDOMNodeId }, page.session);
  };
  const customDuration = async (page, site, value) => {
    await focusDuration(page, site.name); await key(page, 'End', 35);
    await eventually(() => inspect(page, `!document.querySelector('#custom-duration-site-${site.id}').hidden && document.activeElement.id === 'customMinutes-site-${site.id}'`), 'custom duration editor focused');
    await key(page, 'a', 65, 2);
    await browser.cdp.send('Input.insertText', { text: String(value) }, page.session);
    await clickByRole(browser, page, 'button', 'Save custom session time for ' + site.name);
    await eventually(() => inspect(page, `document.querySelector('#accessMinutes-site-${site.id}').value === '${value}' && document.querySelector('#custom-duration-site-${site.id}').hidden`), site.name + ' custom duration saved');
  };
  const journey = (name, run) => t.test(name, () => withFailureArtifacts(browser, name, run));
  try {
    const midday = new Date(); midday.setHours(12, 0, 0, 0);
    await browser.setTime(midday.getTime());
    await journey('the intention field is discoverable without scrolling', async () => {
      for (const width of [390, 320]) {
        const page = await pageAt('/blocked.html?site=x', width);
        await eventually(() => inspect(page, '!document.querySelector("#begin").disabled'), 'gate ready');
        const field = await inspect(page, '({ top: document.querySelector("#reason").getBoundingClientRect().top, viewport: innerHeight, scroll: scrollY })');
        assert.equal(field.scroll, 0); assert.ok(field.top >= 0 && field.top < field.viewport - 24, JSON.stringify({ width, ...field }));
        await noOverflow(page);
      }
    });
    await journey('popup shows all four access actions without session-time controls', async () => {
      for (const width of [400, 320]) {
        const page = await pageAt('/popup.html', width);
        await eventually(() => inspect(page, 'document.querySelectorAll(".access-row").length === 4'), 'popup populated');
        assert.equal(await inspect(page, 'document.querySelectorAll("#access-sites input, #access-sites select").length'), 0);
        const sizes = await inspect(page, '[...document.querySelectorAll("#date, .caption, .goal small, .blocking .section-label > span, .access-row small, .popup-links a, .popup-links button")].map(element => parseFloat(getComputedStyle(element).fontSize))');
        assert.ok(sizes.every(size => size >= 12));
        if (width === 400) assert.equal(await inspect(page, '(() => { const bottom = document.querySelector("main").getBoundingClientRect().bottom; return [...document.querySelectorAll(".access-row")].every(row => row.getBoundingClientRect().bottom <= bottom); })()'), true);
        await noOverflow(page);
      }
    });
    await journey('unpacked Settings hides store feedback without hiding privacy and terms', async () => {
      const page = await pageAt('/settings.html', 320);
      await eventually(() => inspect(page, '!!document.querySelector("#track-x")'), 'Settings ready');
      assert.equal(await inspect(page, '(async () => (await chrome.management.getSelf()).installType)()'), 'development');
      assert.deepEqual(await inspect(page, '["feedback", "feedback-privacy"].map(id => getComputedStyle(document.getElementById(id)).display)'), ['none', 'none']);
      for (const target of ['privacy.html', 'terms.html']) {
        const link = await inspect(page, `(() => { const node = document.querySelector('.feedback a[href="https://createratio.com/${target}"]'); return { visible: node.getClientRects().length > 0, target: node.target, rel: node.rel }; })()`);
        assert.equal(link.visible, true);
        assert.equal(link.target, '_blank');
        assert.equal(link.rel, 'noopener noreferrer');
      }
      await noOverflow(page);
    });
    await journey('section navigation waits for the initial preference-backed layout', async () => {
      const page = await browser.page('about:blank');
      await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime); let first = true;
        chrome.runtime.sendMessage = async message => {
          const reply = await send(message);
          if (message.type === 'snapshot' && first) {
            first = false;
            await new Promise(resolve => {
              globalThis.snapshotHeld = true;
              const finish = () => { globalThis.snapshotHeld = false; resolve(); };
              document.addEventListener('mousemove', finish, { once: true });
              setTimeout(finish, 800);
            });
          }
          return reply;
        };
      })();` }, page.session);
      await browser.cdp.send('Page.navigate', { url: browser.origin + '/settings.html' }, page.session);
      await eventually(() => inspect(page, 'globalThis.snapshotHeld === true'), 'initial snapshot held');
      await openSettingsSection(browser, page, 'data');
      assert.equal(await inspect(page, 'document.querySelectorAll("#site-settings select").length'), 4);
      assert.equal(await inspect(page, 'document.querySelector("#data-settings").open'), true);
      assert.ok(await findByRole(browser, page, 'button', 'Clear history'));
    });
    await journey('native settings sections isolate tasks and keep policy details keyboard accessible', async () => {
      const page = await pageAt('/settings.html', 390);
      await eventually(() => inspect(page, '!!document.querySelector("#track-x")'), 'Settings ready');
      assert.deepEqual(await inspect(page, '[...document.querySelectorAll(".settings-section")].map(section => section.open)'), [true, false, false, false]);
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), false);
      await click(browser, page, '.policy-details summary');
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), true);
      assert.equal(await inspect(page, 'document.hasFocus() && document.activeElement.tagName === "SUMMARY"'), true);
      await key(page, 'Enter', 13);
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), false);
      await openSettingsSection(browser, page, 'browsing');
      assert.equal(await inspect(page, 'document.querySelector("#websites-settings").open'), false);
      assert.ok(await findByRole(browser, page, 'switch', 'Slow scrolling'));
      await openSettingsSection(browser, page, 'privacy');
      assert.equal(await inspect(page, 'document.querySelector("#browsing-settings").open'), false);
      assert.ok(await findByRole(browser, page, 'switch', 'Remember my intentions'));
      await openSettingsSection(browser, page, 'data');
      assert.equal(await inspect(page, 'document.querySelector("#privacy-settings").open'), false);
      assert.ok(await findByRole(browser, page, 'button', 'Export activity CSV'));
      await noOverflow(page);
    });
    await journey('failed custom saves keep the draft and visible feedback until a successful retry', async () => {
      const page = await pageAt('/settings.html', 320);
      await eventually(() => inspect(page, '!!document.querySelector("#accessMinutes-site-x")'), 'Settings ready');
      await inspect(page, `(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime); let fail = true;
        chrome.runtime.sendMessage = message => {
          if (message.type === 'access-duration' && fail) { fail = false; return Promise.resolve({ ok: false, error: 'Could not save session time. Try again.' }); }
          return send(message);
        };
      })()`);
      await focusDuration(page, 'X'); await key(page, 'End', 35);
      await eventually(() => inspect(page, 'document.activeElement.id === "customMinutes-site-x"'), 'custom editor focused');
      await key(page, 'a', 65, 2); await browser.cdp.send('Input.insertText', { text: '17' }, page.session);
      await clickByRole(browser, page, 'button', 'Save custom session time for X');
      await eventually(() => inspect(page, '!document.querySelector("#error").hidden && !document.querySelector("#custom-save-site-x").disabled'), 'failed save acknowledged');
      assert.equal(await inspect(page, 'document.querySelector("#customMinutes-site-x").value'), '17');
      assert.equal(await inspect(page, 'document.querySelector("#custom-duration-site-x").hidden'), false);
      assert.equal(await inspect(page, '(() => { const box = document.querySelector(".settings-feedback").getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()'), true);
      const directory = process.env.BROWSER_ARTIFACT_DIR || path.resolve(__dirname, '../../dist/browser-artifacts');
      await mkdir(directory, { recursive: true });
      const capture = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }, page.session);
      await writeFile(path.join(directory, 'settings-failed-save.png'), Buffer.from(capture.data, 'base64'));
      await clickByRole(browser, page, 'button', 'Save custom session time for X');
      await eventually(() => inspect(page, 'document.querySelector("#custom-duration-site-x").hidden && document.querySelector("#error").hidden && document.querySelector("#accessMinutes-site-x").value === "17"'), 'retry saves the draft');
      await noOverflow(page);
    });
    await journey('all four site menus and switches persist at narrow widths without exposing custom fields', async () => {
      const sites = require('../sites/index.js').sites;
      const catalog = sites.filter(site => site.gated), trackingOnly = sites.filter(site => !site.gated);
      for (const width of [320, 390]) {
        const page = await pageAt('/settings.html', width);
        await eventually(() => inspect(page, 'document.querySelectorAll("#site-settings select").length === 4'), 'catalog menus rendered');
        assert.equal(await inspect(page, 'document.querySelector("#tracking-only-section").hidden'), trackingOnly.length === 0);
        assert.deepEqual(await inspect(page, '[...document.querySelectorAll("#site-settings > li")].map(row => row.dataset.site)'), catalog.map(site => site.id));
        assert.deepEqual(await inspect(page, '[...document.querySelectorAll("#tracking-only-settings > li")].map(row => row.dataset.site)'), trackingOnly.map(site => site.id));
        assert.equal(await inspect(page, '[...document.querySelectorAll("input[type=number]")].filter(input => input.getClientRects().length).length'), 0);
        for (const { id, name } of catalog.filter(site => !site.defaultEnabled)) {
          assert.equal(await inspect(page, `document.querySelector('#track-${id}').checked`), false);
          assert.equal(await inspect(page, `document.querySelector('#accessMinutes-site-${id}').disabled`), true);
          await clickByRole(browser, page, 'switch', 'Limit & track on ' + name);
          await eventually(() => inspect(page, `document.querySelector('#track-${id}').checked && !document.querySelector('#accessMinutes-site-${id}').disabled`), name + ' enabled');
        }
        await browser.cdp.send('Page.reload', {}, page.session);
        await eventually(() => inspect(page, 'document.querySelectorAll("#site-settings input:checked").length === 4'), 'saved switches survive reload');
        for (const { id, name } of catalog.filter(site => !site.defaultEnabled)) {
          await clickByRole(browser, page, 'switch', 'Limit & track on ' + name);
          await eventually(() => inspect(page, `!document.querySelector('#track-${id}').checked && !document.querySelector('#track-${id}').disabled`), name + ' disabled');
        }
        await focusDuration(page, 'X'); await key(page, 'End', 35);
        await eventually(() => inspect(page, 'document.activeElement.id === "customMinutes-site-x"'), 'custom editor focused');
        await key(page, 'a', 65, 2); await browser.cdp.send('Input.insertText', { text: '17' }, page.session);
        await evaluate(browser, browser.worker, `(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, allowAboveGoal: ${width === 320} } }); })()`);
        await eventually(() => inspect(page, `document.querySelector('#allow-above-goal').checked === ${width === 320}`), 'external settings refresh');
        assert.equal(await inspect(page, 'document.activeElement.id === "customMinutes-site-x" && document.activeElement.value === "17"'), true);
        await clickByRole(browser, page, 'button', 'Cancel custom session time for X');
        assert.equal(await inspect(page, 'document.querySelector("#custom-duration-site-x").hidden'), true);
        await noOverflow(page);
      }
    });
    await journey('Settings duration menus save presets, arbitrary custom times and inherited defaults without altering current budgets', async () => {
      const sites = require('../sites/index.js').sites.filter(site => site.gated);
      await seedAccess(browser, sites.map(site => site.id), { trackedSites: sites.map(site => site.id), accessMinutes: 5, siteOverrides: {}, allowAboveGoal: false });
      const page = await pageAt('/settings.html', 1000);
      await eventually(() => inspect(page, '!!document.querySelector("#accessMinutes-default")'), 'Settings ready');
      await focusDuration(page, 'Default'); await key(page, 'ArrowDown', 40);
      await eventually(() => inspect(page, 'document.querySelector("#accessMinutes-default").value === "10" && !document.querySelector("#accessMinutes-default").disabled'), 'preset saved');
      assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data => data.settings.accessMinutes)'), 10);
      for (const [index, site] of sites.entries()) await customDuration(page, site, 17 + index);
      const stored = await evaluate(browser, browser.worker, 'chrome.storage.local.get(["settings", "_access"])');
      for (const [index, site] of sites.entries()) {
        assert.equal(stored.settings.siteOverrides[site.id].accessMinutes, 17 + index);
        assert.equal(stored._access[site.id].remainingMs, 300000, 'editing time does not change a running session');
      }
      assert.equal(await inspect(page, '(() => { const notice = document.querySelector("#save-status").getBoundingClientRect(); return notice.top >= 0 && notice.bottom <= innerHeight; })()'), true);
      await focusDuration(page, 'X'); await key(page, 'Home', 36);
      await eventually(() => inspect(page, 'document.querySelector("#accessMinutes-site-x").value === "default" && !document.querySelector("#accessMinutes-site-x").disabled'), 'Default restored');
      assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data => Object.hasOwn(data.settings.siteOverrides?.x || {}, "accessMinutes"))'), false);
      await browser.cdp.send('Page.reload', {}, page.session);
      await eventually(() => inspect(page, 'document.querySelector("#accessMinutes-site-instagram")?.value === "20"'), 'custom duration survives reload');
      await noOverflow(page);
    });
    await journey('narrow history exposes readable values instead of shrinking the chart', async () => {
      await evaluate(browser, browser.worker, 'chrome.storage.local.set({ [C3.localDate()]: { x: { createSec: 2880, consumeSec: 1920, posts: 2 } } })');
      const page = await pageAt('/dashboard.html', 320);
      await eventually(() => inspect(page, 'document.querySelectorAll("#chart-table tbody tr").length === 7'), 'history populated');
      const table = await inspect(page, '(() => { const table = document.querySelector("#chart-table"), rect = table.parentElement.getBoundingClientRect(); return { width: rect.width, height: rect.height, sizes: [...table.querySelectorAll("th, td")].map(element => parseFloat(getComputedStyle(element).fontSize)), last: [...table.querySelector("tbody").lastElementChild.children].map(element => element.textContent) }; })()');
      assert.ok(table.width >= 200 && table.height > 100); assert.ok(table.sizes.every(size => size >= 12));
      assert.deepEqual(table.last.slice(1), ['48.00', '32.00']); await noOverflow(page);
    });
    assert.deepEqual(browser.errors, []);
  } finally { await browser.cleanup(); }
});
