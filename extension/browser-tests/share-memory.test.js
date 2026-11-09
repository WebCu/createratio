'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const surface of ['dashboard', 'popup']) test(`${surface} previews keep one drawing surface without decoding PNG URLs`, async () => {
  const { launch, evaluate, eventually, click, findByRole, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'bounded share preview', async () => {
      const page = await browser.page(browser.origin + '/' + surface + '.html');
      const inspect = source => evaluate(browser, page.session, source);
      await eventually(() => inspect('document.querySelector("#score")?.textContent === "0.00"'), 'dashboard ready');
      await inspect(`(() => {
        globalThis.liveShareURLs = new Set();
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); liveShareURLs.add(url); return url; };
        URL.revokeObjectURL = url => { liveShareURLs.delete(url); revoke(url); };
      })()`);
      await browser.cdp.send('Network.enable', {}, page.session);
      const imageRequests = [];
      const remove = browser.cdp.on('Network.requestWillBeSent', (event, session) => {
        if (session === page.session && event.request.url.startsWith('blob:')) imageRequests.push(event.request.url);
      });
      try {
        for (let i = 1; i <= 6; i++) {
          await evaluate(browser, browser.worker, `chrome.storage.local.set({ [C3.localDate()]: { x: { createSec: ${i * 60}, consumeSec: 60 } } })`);
          await click(browser, page, '#share-create');
          await eventually(() => inspect('!document.querySelector("#share-create").disabled && !document.querySelector("#share-result").hidden'), 'changing preview ready');
          assert.deepEqual(imageRequests, [], 'the preview must not populate the decoded blob-image cache');
          assert.equal(await inspect('liveShareURLs.size'), 1, 'only the current PNG URL is retained');
          const preview = await inspect(`(() => {
            const node = document.querySelector('#share-preview');
            return { width: node.width, height: node.height, color: [...node.getContext('2d').getImageData(0, 0, 1, 1).data], label: node.getAttribute('aria-label'), canvases: document.querySelectorAll('canvas').length };
          })()`);
          assert.equal(preview.width, 1200); assert.equal(preview.height, 1200);
          assert.deepEqual(preview.color, [249, 249, 252, 255]);
          assert.equal(preview.canvases, 1);
          assert.match(preview.label, new RegExp(`${i}m creating`));
          await findByRole(browser, page, 'image', preview.label);
          if (surface === 'popup') await click(browser, page, '#share-close');
          else await inspect('document.querySelector("#report-range").dispatchEvent(new Event("change"))');
          assert.deepEqual(await inspect('({ width: document.querySelector("#share-preview").width, height: document.querySelector("#share-preview").height, hidden: document.querySelector("#share-result").hidden })'), { width: 0, height: 0, hidden: true });
          assert.equal(await inspect('liveShareURLs.size'), 0);
        }
      } finally { remove(); }
      await inspect(`(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        globalThis.restorePreviewContext = () => { HTMLCanvasElement.prototype.getContext = original; };
        HTMLCanvasElement.prototype.getContext = () => null;
      })()`);
      try {
        await click(browser, page, '#share-create');
        await eventually(() => inspect(`document.querySelector("#${surface === 'popup' ? 'share-error' : 'error'}").textContent.includes("Unable to draw the share card")`), 'drawing failure surfaced');
        assert.deepEqual(await inspect('({ width: document.querySelector("#share-preview").width, height: document.querySelector("#share-preview").height, hidden: document.querySelector("#share-result").hidden, disabled: document.querySelector("#share-download").disabled })'), { width: 0, height: 0, hidden: true, disabled: true });
      } finally { await inspect('restorePreviewContext()'); }
      await click(browser, page, '#share-create');
      await eventually(() => inspect('!document.querySelector("#share-create").disabled && !document.querySelector("#share-result").hidden'), 'retry after drawing failure');
      await inspect('dispatchEvent(new PageTransitionEvent("pagehide"))');
      assert.equal(await inspect('liveShareURLs.size === 0 && document.querySelector("#share-preview").width === 0 && document.querySelector("#share-preview").height === 0 && document.querySelector("#share-result").hidden'), true, 'page teardown releases the preview');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
