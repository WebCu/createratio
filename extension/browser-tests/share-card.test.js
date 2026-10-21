'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

test('built dashboard previews and downloads a private social PNG with a copyable referral caption', async () => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  const { cdp } = browser;
  const inspect = (page, source) => evaluate(browser, page.session, source);
  try {
    await withFailureArtifacts(browser, 'social share card', async () => {
      await browser.setTime(new Date(2026, 2, 9, 12).getTime());
      const fixture = {
        '2026-03-02': { older: { createSec: 99999 } },
        '2026-03-03': { linkedin: { createSec: 3000, consumeSec: 1200, posts: 2, comments: 3 } },
        '2026-03-09': { x: { createSec: 1800, consumeSec: 2400, replies: 4, likes: 8 } },
        _intentions: [{ site: 'x', reason: 'Synthetic private intention must never appear.', requestedAt: new Date(2026, 2, 9, 12).getTime() }],
        '_websiteTime:2026-03-09': { 'private.example': 99999 }
      };
      await evaluate(browser, browser.worker, `chrome.storage.local.set(${JSON.stringify(fixture)})`);
      const page = await browser.page(browser.origin + '/dashboard.html');
      await eventually(() => inspect(page, 'document.querySelector("#score")?.textContent === "0.95"'), 'daily fixture loaded');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false }, page.session);
      const before = await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)');
      await inspect(page, `(() => {
        globalThis.liveShareURLs = new Set();
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); liveShareURLs.add(url); return url; };
        URL.revokeObjectURL = url => { liveShareURLs.delete(url); revoke(url); };
      })()`);
      const preview = async () => {
        await click(browser, page, '#share-create');
        await eventually(() => inspect(page, '!document.querySelector("#share-result").hidden && document.querySelector("#share-preview").complete && document.querySelector("#share-preview").naturalWidth === 1200'), 'real PNG preview ready');
      };
      await preview();
      const drawings = await inspect(page, `(() => {
        const cases = [{ createSec: 4800, consumeSec: 3600, posts: 9 }, { createSec: 120, consumeSec: 1200, replies: 1 }, {}, { createSec: 604800, consumeSec: 86399, posts: 999, replies: 999, comments: 999 }, { consumeSec: 300 }, { posts: 1 }];
        return cases.map(stats => {
          const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), paint = ctx.fillText.bind(ctx), bounds = [];
          ctx.fillText = function(value, x, y, maxWidth) {
            const metrics = this.measureText(value), scale = Math.min(1, maxWidth / Math.max(1, metrics.width));
            bounds.push({ text: String(value), left: x - metrics.actualBoundingBoxLeft * scale, right: x + metrics.actualBoundingBoxRight * scale, top: y - metrics.actualBoundingBoxAscent, bottom: y + metrics.actualBoundingBoxDescent });
            return paint(value, x, y, maxWidth);
          };
          SocialCard.draw(canvas, SocialCard.create({ [C3.localDate()]: { x: stats } }, 'week'));
          const bars = [[314, [195, 177, 232]], [886, [223, 212, 241]]].map(([x, color]) => {
            const pixels = ctx.getImageData(x, 600, 1, 140).data;
            let height = 0;
            for (let i = 0; i < pixels.length; i += 4) if (color.every((channel, index) => pixels[i + index] === channel)) height++;
            return height;
          });
          const largest = Math.max(stats.createSec || 0, stats.consumeSec || 0, 1);
          canvas.width = 0; canvas.height = 0;
          return {
            bars, expectedBars: [140 * (stats.createSec || 0) / largest, 140 * (stats.consumeSec || 0) / largest],
            outside: bounds.filter(rect => rect.left < 48 || rect.right > 1152 || rect.top < 48 || rect.bottom > 1152),
            overlaps: bounds.flatMap((a, index) => bounds.slice(index + 1).filter(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map(b => [a.text, b.text]))
          };
        });
      })()`);
      for (const drawing of drawings) {
        assert.deepEqual(drawing.outside, [], 'card text stays within its safe area');
        assert.deepEqual(drawing.overlaps, [], 'real, empty and large-number text never overlaps');
        drawing.bars.forEach((height, index) => assert.ok(Math.abs(height - drawing.expectedBars[index]) < 2, 'drawn bars reflect raw time, not action credits'));
      }
      const daily = await inspect(page, 'document.querySelector("#share-caption").value');
      assert.match(daily, /Today so far: 30m creating · 40m consuming · 4 posts\/replies\/comments/);
      assert.match(daily, /Made room for creating/);
      assert.match(daily, /https:\/\/createratio\.com\//);
      await inspect(page, 'document.querySelector("#report-range").value = "week"; document.querySelector("#report-range").dispatchEvent(new Event("change"))');
      assert.equal(await inspect(page, 'document.querySelector("#share-result").hidden && document.querySelector("#share-download").disabled && liveShareURLs.size === 0'), true);
      await preview();
      const caption = await inspect(page, 'document.querySelector("#share-caption").value');
      assert.match(caption, /Made room for creating\./);
      assert.match(caption, /approximate/);
      assert.match(caption, /Create > Consume/);
      assert.match(caption, /Last 7 days: 80m creating · 60m consuming · 9 posts\/replies\/comments/);
      assert.match(caption, /Creation score: 1\.63/);
      assert.doesNotMatch(caption, /Synthetic|private\.example|private intention|linkedin|x\.com|older|99999/);
      assert.equal(await inspect(page, 'document.documentElement.scrollWidth <= innerWidth'), true);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: browser.directory, eventsEnabled: true });
      let download, completed = false;
      const removeBegin = cdp.on('Browser.downloadWillBegin', event => { download = event; });
      const removeProgress = cdp.on('Browser.downloadProgress', event => { if (event.guid === download?.guid && event.state === 'completed') completed = true; });
      try {
        await click(browser, page, '#share-download');
        await eventually(() => completed, 'actual share PNG download');
        assert.equal(download.suggestedFilename, 'CreateRatio-share-2026-03-03-to-2026-03-09.png');
        const png = await readFile(path.join(browser.directory, download.guid));
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 1200);
        if (process.env.SHARE_PREVIEW_PATH) await writeFile(process.env.SHARE_PREVIEW_PATH, png);
      } finally { removeBegin(); removeProgress(); }
      await click(browser, page, '#share-copy');
      await eventually(() => inspect(page, 'document.querySelector("#share-status").textContent === "Caption copied. Paste it alongside your image."'), 'native clipboard write');
      await inspect(page, 'Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Permission denied"); } } })');
      await click(browser, page, '#share-copy');
      await eventually(() => inspect(page, 'document.activeElement.id === "share-caption" && document.querySelector("#share-caption").selectionEnd === document.querySelector("#share-caption").value.length'), 'clipboard denial selects the caption for manual copy');
      for (let i = 0; i < 4; i++) { await preview(); assert.equal(await inspect(page, 'liveShareURLs.size'), 1); }
      assert.deepEqual(await evaluate(browser, browser.worker, 'chrome.storage.local.get(null)'), before);
      await inspect(page, 'HTMLCanvasElement.prototype.toBlob = function(callback) { callback(null); }');
      await click(browser, page, '#share-create');
      await eventually(() => inspect(page, 'document.querySelector("#error").textContent.includes("Unable to create the PNG")'), 'PNG failure is actionable');
      assert.equal(await inspect(page, 'document.querySelector("#share-result").hidden && liveShareURLs.size === 0 && !document.querySelector("#share-create").disabled'), true);
      await cdp.send('Page.reload', {}, page.session);
      await eventually(() => inspect(page, 'document.querySelector("#score")?.textContent === "0.95"'), 'reload after encoder failure');
      await preview();
      await inspect(page, `(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = async message => {
          if (message.type === 'history') await new Promise(resolve => { globalThis.releaseShareHistory = resolve; });
          return send(message);
        };
      })()`);
      await click(browser, page, '#share-create');
      await eventually(() => inspect(page, 'typeof releaseShareHistory === "function"'), 'pending history request');
      await inspect(page, 'document.querySelector("#report-range").value = "week"; document.querySelector("#report-range").dispatchEvent(new Event("change")); releaseShareHistory()');
      await eventually(() => inspect(page, '!document.querySelector("#share-create").disabled'), 'stale generation released');
      assert.equal(await inspect(page, 'document.querySelector("#share-result").hidden'), true, 'old period never becomes a shareable card');
      await cdp.send('Page.reload', {}, page.session);
      await eventually(() => inspect(page, 'document.querySelector("#score")?.textContent === "0.95"'), 'reload after delayed history');
      await preview();
      const settings = await browser.page(browser.origin + '/settings.html');
      await eventually(() => inspect(settings, '!!document.querySelector("#clear-history")'), 'Settings clear control loaded');
      assert.equal((await inspect(settings, 'chrome.runtime.sendMessage({ type: "clear-history" })')).ok, true);
      await eventually(() => inspect(page, 'document.querySelector("#share-result").hidden && document.querySelector("#share-download").disabled && !document.querySelector("#share-preview").hasAttribute("src")'), 'clear history discards the retained preview');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
