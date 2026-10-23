'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

for (const surface of ['popup', 'dashboard']) test(`pending caption writes stay bounded across ${surface} preview lifetimes`, async () => {
  const { launch, evaluate, eventually, click, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, `${surface} pending caption write`, async () => {
      const settings = await browser.page(browser.origin + '/settings.html');
      const page = await browser.page(browser.origin + '/' + surface + '.html');
      const inspect = source => evaluate(browser, page.session, source);
      await inspect(`(() => {
        globalThis.captionWrites = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: text => new Promise((resolve, reject) => captionWrites.push({ text, resolve, reject }))
        } });
        globalThis.liveCaptionURLs = new Set();
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); liveCaptionURLs.add(url); return url; };
        URL.revokeObjectURL = url => { liveCaptionURLs.delete(url); revoke(url); };
      })()`);
      const preview = async () => {
        await click(browser, page, '#share-create');
        await eventually(() => inspect('!document.querySelector("#share-result").hidden && !document.querySelector("#share-create").disabled'), 'preview ready');
      };
      const repeat = () => inspect(`for (let i = 0; i < 20; i++) {
        document.querySelector('#share-copy').click();
        document.querySelector('#share-copy').dispatchEvent(new MouseEvent('click'));
      }`);
      const settle = async outcome => {
        await inspect(outcome === 'resolve' ? 'captionWrites.at(-1).resolve()' : 'captionWrites.at(-1).reject(new Error("Permission denied"))');
        await inspect('new Promise(resolve => requestAnimationFrame(resolve))');
      };
      const readFeedback = () => inspect(`({
        status: document.querySelector('#share-status').textContent,
        caption: document.querySelector('#share-caption').value,
        details: document.querySelector('#share-caption-details')?.open ?? false,
        focus: document.activeElement.id
      })`);
      await preview();
      const transitions = ['same', 'preview', 'reset', ...(surface === 'popup' ? ['close', 'close-reopen', 'reset-reopen'] : ['range', 'range-reopen', 'reset-reopen'])];
      for (const outcome of ['resolve', 'reject']) for (const transition of transitions) {
        if (await inspect('document.querySelector("#share-result").hidden')) await preview();
        const before = await inspect('captionWrites.length');
        const caption = await inspect('document.querySelector("#share-caption").value');
        await clickByRole(browser, page, 'button', 'Copy caption');
        await repeat();
        assert.equal(await inspect('captionWrites.length'), before + 1, 'one native write may remain pending per mounted controller');
        assert.equal(await inspect('captionWrites.at(-1).text'), caption);
        assert.equal(await inspect('document.querySelector("#share-copy").disabled'), true);
        if (transition === 'preview') {
          await evaluate(browser, browser.worker, `chrome.storage.local.set({ [C3.localDate()]: { x: { createSec: ${120 + before}, consumeSec: 60 } } })`);
          await preview();
          assert.notEqual(await inspect('document.querySelector("#share-caption").value'), caption);
        } else if (transition !== 'same') {
          if (transition.startsWith('close')) await clickByRole(browser, page, 'button', 'Close share card');
          else if (transition.startsWith('range')) await inspect(`document.querySelector('#report-range').value = document.querySelector('#report-range').value === 'today' ? 'week' : 'today'; document.querySelector('#report-range').dispatchEvent(new Event('change'))`);
          else {
            assert.equal((await evaluate(browser, settings.session, 'chrome.runtime.sendMessage({ type: "clear-history" })')).ok, true);
            await eventually(() => inspect('document.querySelector("#share-result").hidden'), 'history reset clears preview');
          }
          assert.equal(await inspect('document.querySelector("#share-preview").width === 0 && document.querySelector("#share-preview").height === 0 && liveCaptionURLs.size === 0'), true, 'pending caption does not keep drawing resources alive');
          if (transition.startsWith('close')) assert.equal(await inspect('document.activeElement.id'), 'share-create');
          if (transition.endsWith('reopen')) await preview();
        }
        await repeat();
        assert.equal(await inspect('captionWrites.length'), before + 1, 'clearing or replacing a preview cannot admit another native write');
        assert.equal(await inspect('document.querySelector("#share-copy").disabled'), true);
        await inspect('new Promise(resolve => requestAnimationFrame(resolve))');
        const feedback = await readFeedback();
        const closed = await inspect('document.querySelector("#share-result").hidden');
        if (closed) await inspect(`
          globalThis.captionMutations = [];
          globalThis.captionObserver = new MutationObserver(records => captionMutations.push(...records));
          for (const id of ['share-result', 'share-status', 'share-create']) captionObserver.observe(document.getElementById(id), { subtree: true, attributes: true, childList: true, characterData: true });
        `);
        await settle(outcome);
        if (transition === 'same') {
          if (outcome === 'resolve') {
            assert.match((await readFeedback()).status, /^Caption copied/);
            assert.equal((await readFeedback()).focus, feedback.focus);
          } else {
            assert.match((await readFeedback()).status, /^Clipboard unavailable/);
            assert.equal(await inspect('document.activeElement.id === "share-caption" && document.querySelector("#share-caption").selectionEnd === document.querySelector("#share-caption").value.length'), true);
            if (surface === 'popup') assert.equal(await inspect('document.querySelector("#share-caption-details").open'), true);
          }
        } else assert.deepEqual(await readFeedback(), feedback, 'stale settlement cannot change status, caption, fallback or focus');
        if (closed) {
          assert.equal(await inspect('captionMutations.length'), 0, 'settlement after clear makes no preview DOM mutations');
          await inspect('captionObserver.disconnect()');
          await preview();
        }
        assert.equal(await inspect('document.querySelector("#share-copy").disabled'), false, 'settlement restores copy for the current preview');
        await clickByRole(browser, page, 'button', 'Copy caption');
        assert.equal(await inspect('captionWrites.length'), before + 2, 'copy recovers after stale or current settlement');
        await settle('resolve');
        assert.match((await readFeedback()).status, /^Caption copied/);
      }
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});

test('popup shares today locally without opening the dashboard and keeps access controls usable', async () => {
  const { launch, evaluate, eventually, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const inspect = (page, source) => evaluate(browser, page.session, source);
  try {
    await withFailureArtifacts(browser, 'popup share today', async () => {
      await browser.setTime(new Date(2026, 2, 9, 12).getTime());
      await evaluate(browser, browser.worker, `chrome.storage.local.set({
        '2026-03-08': { linkedin: { createSec: 99999 } },
        '2026-03-09': { x: { createSec: 1800, consumeSec: 2400, replies: 4 } },
        _intentions: [{ site: 'x', reason: 'Synthetic private intention.', requestedAt: Date.now() }],
        '_websiteTime:2026-03-09': { 'private.example': 99999 }
      })`);
      const page = await browser.page(browser.origin + '/popup.html');
      await eventually(() => inspect(page, 'document.querySelector("#score")?.textContent === "0.95"'), 'popup ready');
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false }, page.session);
      const before = await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)');
      await inspect(page, `(() => {
        globalThis.shareRequests = [];
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = message => { shareRequests.push(message); return send(message); };
      })()`);
      assert.equal(await inspect(page, 'document.querySelector("#share-result").hidden && document.querySelector("#share-preview").width === 0'), true);
      const targetsBefore = (await browser.cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId).sort();
      const capture = async name => {
        if (!process.env.POPUP_SHARE_SCREENSHOTS) return;
        await mkdir(process.env.POPUP_SHARE_SCREENSHOTS, { recursive: true });
        const { cssContentSize } = await browser.cdp.send('Page.getLayoutMetrics', {}, page.session);
        const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 380, height: Math.ceil(cssContentSize.height), scale: 1 } }, page.session);
        await writeFile(path.join(process.env.POPUP_SHARE_SCREENSHOTS, name + '.png'), Buffer.from(screenshot.data, 'base64'));
      };
      await capture('popup-closed');
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect(page, '!document.querySelector("#share-result").hidden && !document.querySelector("#share-create").disabled'), 'daily card ready in popup');
      const caption = await inspect(page, 'document.querySelector("#share-caption").value');
      assert.match(caption, /Today so far: 30m creating · 40m consuming · 4 detected post\/reply\/comment actions/);
      assert.match(caption, /Creation score: 0\.95/);
      assert.match(caption, /https:\/\/createratio\.com\//);
      assert.doesNotMatch(caption, /Synthetic|private\.example|linkedin|99999/);
      assert.deepEqual(await inspect(page, 'shareRequests.filter(message => message.type === "history")'), [{ type: 'history', kind: 'ratio', range: 'today' }]);
      assert.deepEqual((await browser.cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId).sort(), targetsBefore);
      await capture('popup-open');
      for (const width of [320, 380]) {
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false }, page.session);
        assert.equal(await inspect(page, 'document.documentElement.scrollWidth <= innerWidth'), true, 'popup fits narrow widths');
      }
      await browser.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page.session);
      await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
      let download, completed = false;
      const removeBegin = browser.cdp.on('Browser.downloadWillBegin', event => { download = event; });
      const removeProgress = browser.cdp.on('Browser.downloadProgress', event => { if (event.guid === download?.guid && event.state === 'completed') completed = true; });
      try {
        await clickByRole(browser, page, 'button', 'Download PNG');
        await eventually(() => completed, 'popup PNG download');
        assert.equal(download.suggestedFilename, 'CreateRatio-share-2026-03-09.png');
        const png = await readFile(path.join(browser.directory, download.guid));
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 1200);
      } finally { removeBegin(); removeProgress(); }
      await clickByRole(browser, page, 'button', 'Copy caption');
      await eventually(() => inspect(page, 'document.querySelector("#share-status").textContent.startsWith("Caption copied")'), 'clipboard success');
      await inspect(page, 'Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Permission denied"); } } })');
      await clickByRole(browser, page, 'button', 'Copy caption');
      await eventually(() => inspect(page, 'document.querySelector("#share-caption-details").open && document.activeElement.id === "share-caption" && document.querySelector("#share-caption").selectionEnd === document.querySelector("#share-caption").value.length'), 'denied clipboard expands and selects caption');
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 600, deviceScaleFactor: 1, mobile: false }, page.session);
      await capture('popup-caption');
      await clickByRole(browser, page, 'button', 'Close share card');
      assert.equal(await inspect(page, 'document.activeElement.id === "share-create" && document.querySelector("#share-create").getAttribute("aria-expanded") === "false" && document.querySelector("#share-result").hidden && document.querySelector("#share-preview").width === 0 && document.querySelector("#share-preview").height === 0'), true);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, page.session);
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, page.session);
      await eventually(() => inspect(page, 'document.querySelector("#share-create").getAttribute("aria-expanded") === "true"'), 'keyboard opens share preview');
      await clickByRole(browser, page, 'button', 'Close share card');
      assert.deepEqual(await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)'), before);
      await clickByRole(browser, page, 'button', 'Request access to X');
      await eventually(async () => (await browser.cdp.send('Target.getTargets')).targetInfos.some(target => target.url === browser.origin + '/blocked.html?site=x'), 'access controls still open the gate');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});

test('popup sharing rejects stale history, encoder failures and midnight rollover, with retry', async () => {
  const { launch, evaluate, eventually, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'popup share recovery', async () => {
      await browser.setTime(new Date(2026, 2, 9, 23, 59, 50).getTime());
      const page = await browser.page(browser.origin + '/popup.html');
      const inspect = source => evaluate(browser, page.session, source);
      await eventually(() => inspect('document.querySelector("#score")?.textContent === "0.00"'), 'empty popup ready');
      await inspect(`(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        globalThis.pauseShareHistory = false;
        chrome.runtime.sendMessage = async message => {
          if (message.type === 'history' && pauseShareHistory) await new Promise(resolve => { globalThis.releaseShareHistory = resolve; });
          return send(message);
        };
      })()`);
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect('!document.querySelector("#share-result").hidden'), 'empty share card ready');
      assert.match(await inspect('document.querySelector("#share-caption").value'), /A fresh start\. Room to create\./);
      await inspect('globalThis.pauseShareHistory = true');
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect('typeof releaseShareHistory === "function"'), 'pending popup history');
      assert.equal(await inspect('document.querySelector("#share-create").disabled && document.querySelector("#share-create").textContent === "Preparing…" && document.querySelector("#share-result").hidden'), true);
      assert.equal((await inspect('chrome.runtime.sendMessage({ type: "clear-history" })')).ok, true);
      await inspect('pauseShareHistory = false; releaseShareHistory()');
      await eventually(() => inspect('!document.querySelector("#share-create").disabled'), 'reset releases request');
      assert.equal(await inspect('document.querySelector("#share-result").hidden && document.querySelector("#share-preview").width === 0'), true);
      await inspect('pauseShareHistory = true; delete globalThis.releaseShareHistory');
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect('typeof releaseShareHistory === "function"'), 'pending midnight request');
      await browser.setTime(new Date(2026, 2, 10, 0, 0, 5).getTime());
      await inspect('pauseShareHistory = false; releaseShareHistory()');
      await eventually(() => inspect('document.querySelector("#share-error").textContent.includes("local date changed")'), 'date rollover asks for retry');
      await eventually(() => inspect('document.querySelector("#date").dateTime === "2026-03-10"'), 'normal popup refresh');
      assert.match(await inspect('document.querySelector("#share-error").textContent'), /Please try again/);
      await inspect('globalThis.originalToBlob = HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob = callback => callback(null)');
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect('document.querySelector("#share-error").textContent.includes("Unable to create the PNG")'), 'encoder failure');
      assert.equal(await inspect('document.querySelector("#share-preview").width === 0 && document.querySelector("#share-download").disabled && !document.querySelector("#share-create").disabled'), true);
      await inspect('HTMLCanvasElement.prototype.toBlob = originalToBlob');
      await clickByRole(browser, page, 'button', 'Share today');
      await eventually(() => inspect('!document.querySelector("#share-result").hidden'), 'retry works');
      assert.match(await inspect('document.querySelector("#share-preview").getAttribute("aria-label")'), /2026-03-10/);
      assert.equal(await inspect('document.querySelector("#share-error").hidden'), true);
      assert.equal((await inspect('chrome.runtime.sendMessage({ type: "clear-history" })')).ok, true);
      await eventually(() => inspect('document.querySelector("#share-result").hidden && document.querySelector("#share-preview").width === 0 && document.querySelector("#share-create").getAttribute("aria-expanded") === "false"'), 'reset discards ready card');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
