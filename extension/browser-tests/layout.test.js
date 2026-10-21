'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('built extension keeps narrow tasks and history readable', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
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
