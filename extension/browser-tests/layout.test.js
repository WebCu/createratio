'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('built extension keeps narrow tasks and history readable', async t => {
  const { launch, evaluate, eventually, click, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
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
  try {
    const midday = new Date(); midday.setHours(12, 0, 0, 0);
    await browser.setTime(midday.getTime());
    await t.test('the intention field is discoverable without scrolling', () => withFailureArtifacts(browser, 'narrow intention field', async () => {
      for (const width of [390, 320]) {
        const page = await pageAt('/blocked.html?site=x', width);
        await eventually(() => inspect(page, '!document.querySelector("#begin").disabled'), 'gate ready');
        const field = await inspect(page, '({ top: document.querySelector("#reason").getBoundingClientRect().top, viewport: innerHeight, scroll: scrollY })');
        assert.equal(field.scroll, 0);
        assert.ok(field.top >= 0 && field.top < field.viewport - 24, JSON.stringify({ width, ...field }));
        await noOverflow(page);
      }
    }));
    await t.test('popup metadata stays readable in a compact document', () => withFailureArtifacts(browser, 'compact popup text', async () => {
      const page = await pageAt('/popup.html', 360);
      await eventually(() => inspect(page, 'document.querySelector("#score").textContent !== "-"'), 'popup populated');
      const sizes = await inspect(page, '[...document.querySelectorAll("#date, .caption, .goal small, .blocking .section-label > span, .access-row small, .popup-links a, .popup-links button")].map(element => ({ text: element.textContent, size: parseFloat(getComputedStyle(element).fontSize) }))');
      assert.ok(sizes.length >= 7);
      for (const entry of sizes) assert.ok(entry.size >= 12, JSON.stringify(entry));
      await noOverflow(page);
    }));
    await t.test('advanced session guidance opens with a pointer and closes with the keyboard', () => withFailureArtifacts(browser, 'native policy disclosure', async () => {
      const page = await pageAt('/settings.html', 390);
      await eventually(() => inspect(page, '!!document.querySelector("#track-x") && !document.querySelector("#track-x").disabled'), 'site controls ready');
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), false);
      await click(browser, page, '.policy-details summary');
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), true);
      assert.equal(await inspect(page, 'document.hasFocus() && document.activeElement.tagName === "SUMMARY"'), true);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, page.session);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.session);
      assert.equal(await inspect(page, 'document.querySelector(".policy-details").open'), false);
      assert.equal(await inspect(page, 'document.activeElement.tagName'), 'SUMMARY');
      await noOverflow(page);
    }));
    await t.test('Settings separates access limits from opt-in tracking at narrow widths', () => withFailureArtifacts(browser, 'narrow catalog settings', async () => {
      const sites = require('../sites/index.js').sites.filter(site => !site.gated);
      for (const width of [320, 390]) {
        const page = await pageAt('/settings.html', width);
        await eventually(() => inspect(page, `document.querySelector('#accessMinutes-default') && document.querySelectorAll('#tracking-only-settings input[role=switch]').length === ${sites.length}`), 'catalog controls rendered');
        assert.equal(await inspect(page, 'document.querySelector("#tracking-only-section").hidden'), sites.length === 0);
        assert.deepEqual(await inspect(page, '[...document.querySelectorAll("#site-settings > li")].map(row => row.dataset.site)'), ['', 'x', 'linkedin']);
        assert.equal(await inspect(page, 'document.querySelectorAll("#site-settings input[type=number]").length'), 3);
        for (const { id, name } of sites) {
          const row = await inspect(page, `(() => {
            const row = document.querySelector('#tracking-only-settings [data-site=${id}]'), input = row.querySelector('input');
            return { checked: input.checked, disabled: input.disabled, inputs: row.querySelectorAll('input').length, fields: row.querySelectorAll('.site-preference-field, button').length, height: row.getBoundingClientRect().height, describedBy: input.getAttribute('aria-describedby') };
          })()`);
          assert.equal(row.checked, false); assert.equal(row.disabled, false);
          assert.equal(row.inputs, 1); assert.equal(row.fields, 0); assert.ok(row.height <= 80, JSON.stringify({ width, id, ...row }));
          assert.ok(row.describedBy.includes('tracking-only-note'));
          await clickByRole(browser, page, 'switch', 'Track creating & consuming on ' + name);
          await eventually(() => inspect(page, `document.querySelector('#track-${id}').checked && !document.querySelector('#track-${id}').disabled`), id + ' tracking enabled');
        }
        await browser.cdp.send('Page.reload', {}, page.session);
        await eventually(() => inspect(page, `document.querySelector('#accessMinutes-default') && document.querySelectorAll('#tracking-only-settings input:checked').length === ${sites.length}`), 'tracking preferences survive reload');
        for (const { id, name } of sites) {
          await clickByRole(browser, page, 'switch', 'Track creating & consuming on ' + name);
          await eventually(() => inspect(page, `!document.querySelector('#track-${id}').checked && !document.querySelector('#track-${id}').disabled`), id + ' tracking disabled');
        }
        assert.equal(await inspect(page, 'document.querySelectorAll("#tracking-only-settings input[type=number]").length'), 0);
        await inspect(page, 'globalThis.settingsDraft = document.querySelector("#accessMinutes-site-x"); settingsDraft.focus(); settingsDraft.value = "17";');
        await evaluate(browser, browser.worker, '(async () => { const { settings = C3.DEFAULT_SETTINGS } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, allowAboveGoal: !settings.allowAboveGoal } }); })()');
        await eventually(() => inspect(page, `document.querySelector('#allow-above-goal').checked === ${width === 320}`), 'external settings refresh');
        assert.equal(await inspect(page, 'document.activeElement === settingsDraft && settingsDraft === document.querySelector("#accessMinutes-site-x") && settingsDraft.value === "17"'), true);
        assert.equal(await inspect(page, 'document.querySelectorAll("#scroll-friction-enabled").length'), 1);
        assert.equal(await inspect(page, 'document.querySelectorAll("#scroll-friction-strength").length'), 1);
        await noOverflow(page);
      }
    }));
    await t.test('narrow history exposes readable values instead of shrinking the chart', () => withFailureArtifacts(browser, 'narrow history values', async () => {
      await evaluate(browser, browser.worker, 'chrome.storage.local.set({ [C3.localDate()]: { x: { createSec: 2880, consumeSec: 1920, posts: 2 } } })');
      const page = await pageAt('/dashboard.html', 320);
      await eventually(() => inspect(page, 'document.querySelectorAll("#chart-table tbody tr").length === 7'), 'history populated');
      const table = await inspect(page, '(() => { const table = document.querySelector("#chart-table"), rect = table.parentElement.getBoundingClientRect(); return { width: rect.width, height: rect.height, sizes: [...table.querySelectorAll("th, td")].map(element => parseFloat(getComputedStyle(element).fontSize)), last: [...table.querySelector("tbody").lastElementChild.children].map(element => element.textContent) }; })()');
      assert.ok(table.width >= 200 && table.height > 100, JSON.stringify(table));
      assert.ok(table.sizes.every(size => size >= 12), JSON.stringify(table.sizes));
      assert.deepEqual(table.last.slice(1), ['48.00', '32.00']);
      await noOverflow(page);
    }));
    assert.deepEqual(browser.errors, []);
  } finally { await browser.cleanup(); }
});
