'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('built dashboard downloads local daily and weekly reports that render and print offline', async () => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  try {
    await withFailureArtifacts(browser, 'readable report downloads', async () => {
      await browser.setTime(new Date(2026, 2, 9, 12).getTime());
      const fixture = {
        '2026-03-02': { older: { createSec: 99999 } },
        '2026-03-03': { retired: { createSec: 120, consumeSec: 60, posts: 1, quotes: 1 } },
        '2026-03-09': { x: { createSec: 60, consumeSec: 180, replies: 1, likes: 4 } },
        _intentions: [{ site: 'x', reason: 'Synthetic private intention excluded from reports.', requestedAt: new Date(2026, 2, 9, 12).getTime() }],
        '_websiteTime:2026-03-09': { 'private.example': 99999 }
      };
      await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify(fixture)})`);
      const dashboard = await browser.page(browser.origin + '/dashboard.html');
      await eventually(() => inspect(dashboard, 'document.querySelector("#score")?.textContent === "1.00"'), 'dashboard fixture totals');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, dashboard.session);
      assert.equal(await inspect(dashboard, 'document.documentElement.scrollWidth <= innerWidth'), true, 'report controls fit a narrow dashboard');
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
      const download = async filename => {
        let event, done = false;
        const removeBegin = cdp.on('Browser.downloadWillBegin', value => { event = value; });
        const removeProgress = cdp.on('Browser.downloadProgress', value => { if (value.guid === event?.guid && value.state === 'completed') done = true; });
        try {
          await click(browser, dashboard, '#report-export');
          await eventually(() => done, 'actual HTML report download');
          assert.equal(event.suggestedFilename, filename);
          return await readFile(path.join(browser.directory, event.guid), 'utf8');
        } finally { removeBegin(); removeProgress(); }
      };
      const before = await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)');
      const daily = await download('CreateRatio-report-2026-03-09.html');
      assert.match(daily, /<dt>Creating<\/dt><dd>1\.0m<\/dd>/);
      assert.match(daily, /<dt>Period creation score<\/dt><dd>1\.00<\/dd>/);
      assert.doesNotMatch(daily, /2026-03-03|retired/);
      await click(browser, dashboard, '#report-range');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, dashboard.session);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, dashboard.session);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, dashboard.session);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, dashboard.session);
      await eventually(() => inspect(dashboard, 'document.querySelector("#report-range").value === "week"'), 'keyboard selects weekly period');
      const weekly = await download('CreateRatio-report-2026-03-03-to-2026-03-09.html');
      assert.match(weekly, /<dt>Creating<\/dt><dd>3\.0m<\/dd>/);
      assert.match(weekly, /<dt>Period creation score<\/dt><dd>1\.75<\/dd>/);
      assert.match(weekly, /retired \(unavailable\)/);
      for (const html of [daily, weekly]) assert.doesNotMatch(html, /2026-03-02|99999|Synthetic private intention|private\.example|<script/);
      assert.deepEqual(await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)'), before);
      const file = path.join(browser.directory, 'report.html');
      await writeFile(file, weekly);
      const report = await browser.page(pathToFileURL(file).href);
      await eventually(() => inspect(report, 'document.querySelector("h1")?.textContent === "Creation report"'), 'downloaded report renders offline');
      assert.equal(await inspect(report, 'document.querySelector(".summary dd").textContent'), '3.0m');
      assert.equal(await inspect(report, 'document.querySelectorAll("table")[1].tBodies[0].rows.length'), 7);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, report.session);
      assert.equal(await inspect(report, 'document.documentElement.scrollWidth <= innerWidth'), true);
      const pdf = await cdp.send('Page.printToPDF', { printBackground: true }, report.session);
      assert.ok(Buffer.from(pdf.data, 'base64').length > 1000, 'downloaded report prints to a real PDF');
      await click(browser, dashboard, '#intentions-view');
      assert.equal(await inspect(dashboard, 'document.querySelector("#report-export").getClientRects().length'), 0);
      await click(browser, dashboard, '#ratio-view');
      assert.equal(await inspect(dashboard, 'document.querySelector("#report-range").value'), 'week');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
