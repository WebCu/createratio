'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('receipt rollover preserves ready and pending PNG snapshots but Clear history discards them', async t => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  try {
    await browser.setTime(new Date(2026, 5, 15, 12).getTime());
    const dashboard = await browser.page('about:blank'), settings = await browser.page(browser.origin + '/settings.html');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.setInterval = () => 0;' }, dashboard.session);
    await eventually(() => inspect(settings, '!!document.querySelector("#clear-history")'), 'Settings ready');
    const date = await evaluate(browser, browser.worker, 'C3.localDate()');
    const ready = () => eventually(() => inspect(dashboard, '!document.querySelector("#share-result").hidden && document.querySelector("#share-preview").complete && document.querySelector("#share-preview").naturalWidth === 1200'), 'PNG ready');
    const rollover = async seconds => {
      await evaluate(browser, browser.worker, `chrome.storage.local.set({ _historyGeneration: crypto.randomUUID(), _receipts: [crypto.randomUUID()], [C3.localDate()]: { x: { createSec: ${seconds}, consumeSec: 60, posts: 1 } } })`);
      await eventually(() => inspect(dashboard, `document.querySelector('#create-min').textContent === '${(seconds / 60).toFixed(1)}m'`), 'rollover update reaches dashboard');
    };
    const hold = stage => inspect(dashboard, `(() => {
      delete globalThis.releasePreview;
      if (${JSON.stringify(stage)} === 'history') {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let once = true;
        chrome.runtime.sendMessage = async message => {
          const reply = await send(message);
          if (message.type === 'history' && once) { once = false; await new Promise(resolve => { globalThis.releasePreview = resolve; }); }
          return reply;
        };
      } else {
        const encode = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
          HTMLCanvasElement.prototype.toBlob = encode;
          return encode.call(this, blob => { globalThis.releasePreview = () => callback(blob); }, ...args);
        };
      }
    })()`);
    for (const stage of ['history', 'encoding']) await t.test(stage, () => withFailureArtifacts(browser, `receipt rollover during ${stage}`, async () => {
      await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify({ [date]: { x: { createSec: 180, consumeSec: 60, posts: 1 } }, _historyGeneration: 'initial', _historyReset: true, _receipts: ['initial-packet'] })})`);
      await cdp.send('Page.navigate', { url: browser.origin + '/dashboard.html' }, dashboard.session);
      await eventually(() => inspect(dashboard, 'document.querySelector("#create-min")?.textContent === "3.0m"'), 'fixture ready');
      await click(browser, dashboard, '#share-create'); await ready();
      const initialURL = await inspect(dashboard, 'document.querySelector("#share-preview").src');
      await rollover(240);
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-result").hidden'), false, 'receipt turnover must preserve a ready snapshot');
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-preview").src'), initialURL);
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-download").disabled'), false);
      await hold(stage); await click(browser, dashboard, '#share-create');
      await eventually(() => inspect(dashboard, 'typeof releasePreview === "function"'), 'preview held');
      await rollover(300);
      await inspect(dashboard, 'releasePreview()'); await ready();
      assert.match(await inspect(dashboard, 'document.querySelector("#share-caption").value'), /4m creating/);
      await hold(stage); await click(browser, dashboard, '#share-create');
      await eventually(() => inspect(dashboard, 'typeof releasePreview === "function"'), 'second preview held before clear');
      assert.equal((await inspect(settings, 'chrome.runtime.sendMessage({ type: "clear-history" })')).ok, true);
      await eventually(() => inspect(dashboard, 'document.querySelector("#create-min").textContent === "0.0m"'), 'history reset received');
      await inspect(dashboard, 'releasePreview()');
      await eventually(() => inspect(dashboard, '!document.querySelector("#share-create").disabled'), 'cleared pending preview completes');
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-result").hidden'), true);
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-download").disabled'), true);
      assert.equal(await inspect(dashboard, 'document.querySelector("#share-preview").hasAttribute("src")'), false);
    }));
    assert.deepEqual(browser.errors, []);
  } finally { await browser.cleanup(); }
});
