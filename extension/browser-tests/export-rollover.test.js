'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test('daily and weekly exports reject history selected before midnight and recover on retry', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  const downloads = [], completed = new Set();
  const removeBegin = cdp.on('Browser.downloadWillBegin', event => downloads.push(event));
  const removeProgress = cdp.on('Browser.downloadProgress', event => { if (event.state === 'completed') completed.add(event.guid); });
  try {
    const page = await browser.page('about:blank');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.setInterval = () => 0;' }, page.session);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
    const fixture = {
      '2026-12-25': { x: { createSec: 120, consumeSec: 60, posts: 1 } },
      '2026-12-31': { x: { createSec: 60, consumeSec: 120, posts: 1 } },
      '2027-01-01': { x: { createSec: 180, consumeSec: 120 } }
    };
    for (const kind of ['share', 'report']) for (const range of ['today', 'week']) {
      await t.test(`${kind} ${range}`, () => withFailureArtifacts(browser, `${kind} ${range} date rollover`, async () => {
        await browser.setTime(new Date(2026, 11, 31, 23, 59).getTime());
        await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify(fixture)})`);
        await cdp.send('Page.navigate', { url: browser.origin + '/dashboard.html' }, page.session);
        await eventually(() => inspect(page, 'document.querySelector("#date")?.dateTime === "2026-12-31" && document.querySelector("#score")?.textContent === "1.50"'), 'pre-midnight dashboard loaded');
        await inspect(page, `document.querySelector('#report-range').value = ${JSON.stringify(range)}; document.querySelector('#report-range').dispatchEvent(new Event('change'))`);
        await inspect(page, `(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime), create = URL.createObjectURL.bind(URL);
          let hold = true;
          globalThis.rolloverURLs = 0;
          URL.createObjectURL = blob => { rolloverURLs++; return create(blob); };
          chrome.runtime.sendMessage = async message => {
            const reply = await send(message);
            if (message.type === 'history' && hold) {
              hold = false; globalThis.selectedHistory = reply;
              await new Promise(resolve => { globalThis.releaseHistory = resolve; });
            }
            return reply;
          };
        })()`);
        const selector = kind === 'share' ? '#share-create' : '#report-export';
        const beforeDownloads = downloads.length;
        await click(browser, page, selector);
        await eventually(() => inspect(page, 'typeof releaseHistory === "function"'), 'history selected before midnight');
        assert.equal(await inspect(page, 'selectedHistory.days["2026-12-31"].x.createSec'), 60);
        if (range === 'week') assert.equal(await inspect(page, 'selectedHistory.days["2026-12-25"].x.createSec'), 120);
        await inspect(page, 'globalThis.__browserSmokeOffset += 120000; releaseHistory()');
        await eventually(() => inspect(page, `!document.querySelector(${JSON.stringify(selector)}).disabled`), 'export finishes after the date change');
        assert.equal(await inspect(page, 'document.querySelector("#error").textContent'), 'The local date changed while loading history. Please try again.');
        assert.equal(await inspect(page, 'rolloverURLs'), 0, 'no blank or truncated artifact is created');
        assert.equal(downloads.length, beforeDownloads);
        assert.equal(await inspect(page, 'document.querySelector("#share-result").hidden'), true);
        await browser.setTime(new Date(2027, 0, 1, 0, 1).getTime());
        await inspect(page, 'chrome.runtime.sendMessage({ type: "snapshot" })');
        await click(browser, page, selector);
        const period = range === 'today' ? '2027-01-01' : '2026-12-26-to-2027-01-01';
        const minutes = range === 'today' ? '3m' : '4m';
        if (kind === 'share') {
          await eventually(() => inspect(page, '!document.querySelector("#share-result").hidden && !document.querySelector("#share-create").disabled && document.querySelector("#share-preview").width === 1200 && document.querySelector("#share-preview").height === 1200'), 'retry produces a PNG preview');
          const caption = await inspect(page, 'document.querySelector("#share-caption").value');
          assert.ok(caption.includes(`${minutes} creating`));
          await click(browser, page, '#share-download');
        }
        await eventually(() => downloads.length === beforeDownloads + 1 && completed.has(downloads.at(-1).guid), 'retried artifact downloads');
        const download = downloads.at(-1);
        assert.equal(download.suggestedFilename, `CreateRatio-${kind === 'share' ? 'share' : 'report'}-${period}.${kind === 'share' ? 'png' : 'html'}`);
        if (kind === 'report') {
          const html = await readFile(path.join(browser.directory, download.guid), 'utf8');
          assert.ok(html.includes(`<dt>Creating</dt><dd>${range === 'today' ? '3.0m' : '4.0m'}</dd>`));
          assert.ok(html.includes('2027-01-01'));
        }
        assert.equal(await inspect(page, 'document.querySelector("#error").hidden'), true);
      }));
    }
    assert.deepEqual(browser.errors, []);
  } finally { removeBegin(); removeProgress(); await browser.cleanup(); }
});
