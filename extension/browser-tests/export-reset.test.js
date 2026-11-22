'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

for (const [pageName, kind] of [['dashboard', 'websites'], ['settings', 'ratio']]) {
  test(`${pageName} ${kind} CSV cannot download a pre-reset history reply`, async () => {
    const { launch, evaluate, eventually, click, openSettingsSection, withFailureArtifacts } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    const inspect = (page, source) => evaluate(browser, page.session, source);
    const downloads = [], completed = new Set();
    const removeBegin = browser.cdp.on('Browser.downloadWillBegin', event => downloads.push(event));
    const removeProgress = browser.cdp.on('Browser.downloadProgress', event => { if (event.state === 'completed') completed.add(event.guid); });
    try {
      await withFailureArtifacts(browser, `${pageName} ${kind} CSV reset`, async () => {
        await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
        const date = await evaluate(browser, browser.worker, 'Core.localDate()');
        await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify({ [date]: { x: { createSec: 180 } }, ['_websiteTime:' + date]: { 'cleared.test': 180 } })})`);
        const page = await browser.page(browser.origin + '/' + pageName + '.html');
        const settings = pageName === 'settings' ? page : await browser.page(browser.origin + '/settings.html');
        await openSettingsSection(browser, settings, 'data');
        const selector = pageName === 'settings' ? '#export-' + kind : kind === 'ratio' ? '#export' : '#website-export';
        if (pageName === 'dashboard' && kind === 'websites') await click(browser, page, '#websites-view');
        await eventually(() => inspect(page, `!document.querySelector('${selector}').disabled`), 'CSV export ready');
        await inspect(page, `(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          let hold = true;
          chrome.runtime.sendMessage = async message => {
            const reply = await send(message);
            if (message.type === 'history' && hold) {
              hold = false; globalThis.preResetHistory = reply;
              await new Promise(resolve => { globalThis.releaseExportHistory = resolve; });
            }
            return reply;
          };
        })()`);
        await click(browser, page, selector);
        await eventually(() => inspect(page, 'typeof releaseExportHistory === "function"'), 'pre-reset CSV history held');
        assert.ok(await inspect(page, `Object.keys(preResetHistory.days).length`));
        let dialog;
        const removeDialog = browser.cdp.on('Page.javascriptDialogOpening', event => { dialog = event; });
        try {
          const clearing = click(browser, settings, '#clear-history'); clearing.catch(() => {});
          await eventually(() => dialog, 'clear confirmation');
          await browser.cdp.send('Page.handleJavaScriptDialog', { accept: true }, settings.session);
          await clearing;
        } finally { removeDialog(); }
        await eventually(() => inspect(settings, 'document.querySelector("#save-status").textContent.startsWith("History cleared and creation score reset.")'), 'history cleared');
        if (pageName === 'dashboard') {
          const total = kind === 'ratio' ? '#create-min' : '#website-total';
          const empty = kind === 'ratio' ? '0.0m' : '0s';
          await eventually(() => inspect(page, `document.querySelector('${total}').textContent === '${empty}'`), 'dashboard renders cleared history');
        }
        await inspect(page, 'releaseExportHistory()');
        await eventually(() => inspect(page, 'document.querySelector("#error").textContent === "History changed while loading. Please try again."'), 'stale CSV rejected');
        assert.equal(downloads.length, 0);
        await click(browser, page, selector);
        await eventually(() => downloads.length === 1 && completed.has(downloads[0].guid), 'empty CSV retry downloaded');
        const csv = await readFile(path.join(browser.directory, downloads[0].guid), 'utf8');
        assert.equal(csv.trim().split('\n').length, 1);
        assert.deepEqual(browser.errors, []);
      });
    } finally { removeBegin(); removeProgress(); await browser.cleanup(); }
  });
}

test('pending HTML exports cannot download activity after Clear history', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts, openSettingsSection } = await import('./chromium.mjs');
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
    await openSettingsSection(browser, settings, 'data');
    const date = await evaluate(browser, browser.worker, 'Core.localDate()');
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
