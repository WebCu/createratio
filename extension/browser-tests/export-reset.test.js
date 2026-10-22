'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('pending HTML exports cannot download activity after Clear history', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const downloads = [], completed = new Set();
  const removeBegin = cdp.on('Browser.downloadWillBegin', event => downloads.push(event));
  const removeProgress = cdp.on('Browser.downloadProgress', event => { if (event.state === 'completed') completed.add(event.guid); });
  try {
    await browser.setTime(new Date(2026, 5, 15, 12).getTime());
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
    const dashboard = await browser.page('about:blank'), settings = await browser.page(browser.origin + '/settings.html');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.setInterval = () => 0;' }, dashboard.session);
    await eventually(() => inspect(settings, '!!document.querySelector("#clear-history")'), 'Settings loaded');
    const date = await evaluate(browser, browser.worker, 'C3.localDate()');
    for (const range of ['today', 'week']) await t.test(range, () => withFailureArtifacts(browser, `HTML ${range} reset race`, async () => {
      await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify({ [date]: { x: { createSec: 180, consumeSec: 60, posts: 1 } } })})`);
      await cdp.send('Page.navigate', { url: browser.origin + '/dashboard.html' }, dashboard.session);
      await eventually(() => inspect(dashboard, 'document.querySelector("#create-min")?.textContent === "3.0m"'), 'activity visible before export');
      await inspect(dashboard, `document.querySelector('#report-range').value = ${JSON.stringify(range)}`);
      await inspect(dashboard, `(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime), create = URL.createObjectURL.bind(URL);
        let hold = true;
        globalThis.exportURLs = 0;
        URL.createObjectURL = blob => { exportURLs++; return create(blob); };
        chrome.runtime.sendMessage = async message => {
          const reply = await send(message);
          if (message.type === 'history' && hold) {
            hold = false; globalThis.preResetHistory = reply;
            await new Promise(resolve => { globalThis.releaseExportHistory = resolve; });
          }
          return reply;
        };
      })()`);
      const beforeDownloads = downloads.length;
      await click(browser, dashboard, '#report-export');
      await eventually(() => inspect(dashboard, 'typeof releaseExportHistory === "function"'), 'pre-reset history reply held');
      assert.equal(await inspect(dashboard, `preResetHistory.days[${JSON.stringify(date)}].x.createSec`), 180);
      let dialog;
      const removeDialog = cdp.on('Page.javascriptDialogOpening', (event, session) => { if (session === settings.session) dialog = event; });
      try {
        const clearing = click(browser, settings, '#clear-history'); clearing.catch(() => {});
        await eventually(() => dialog, 'native Clear history confirmation');
        assert.equal(dialog.type, 'confirm');
        await cdp.send('Page.handleJavaScriptDialog', { accept: true }, settings.session);
        await clearing;
      } finally { removeDialog(); }
      await eventually(() => inspect(dashboard, 'document.querySelector("#create-min").textContent === "0.0m"'), 'dashboard receives history reset');
      await inspect(dashboard, 'releaseExportHistory()');
      await eventually(() => inspect(dashboard, '!document.querySelector("#report-export").disabled'), 'stale export finishes');
      assert.equal(await inspect(dashboard, 'exportURLs'), 0, 'cleared activity never becomes an artifact');
      assert.equal(downloads.length, beforeDownloads);
      assert.equal(await inspect(dashboard, 'document.querySelector("#error").textContent'), 'History changed while loading. Please try again.');
      await click(browser, dashboard, '#report-export');
      await eventually(() => downloads.length === beforeDownloads + 1 && completed.has(downloads.at(-1).guid), 'retry downloads the cleared report');
      const html = await readFile(path.join(browser.directory, downloads.at(-1).guid), 'utf8');
      assert.ok(html.includes('<dt>Creating</dt><dd>0.0m</dd>'));
      assert.ok(html.includes('<dt>Posts</dt><dd>0</dd>'));
      assert.equal(await inspect(dashboard, 'document.querySelector("#error").hidden'), true);
    }));
    assert.deepEqual(browser.errors, []);
  } finally { removeBegin(); removeProgress(); await browser.cleanup(); }
});
