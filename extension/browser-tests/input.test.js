'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('trusted input follows a late scroll update instead of clicking the adjacent cancel button', async () => {
  const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'late scroll input regression', async () => {
      const html = `<!doctype html><title>Late scroll fixture</title>
        <style>body{height:2000px;margin:0}button{position:absolute;left:20px;width:200px;height:40px}#open{top:1000px}#cancel{top:1064px}</style>
        <button id="open">Open</button><button id="cancel">Cancel</button><output id="result"></output>
        <script>
          const openButton = document.querySelector('#open');
          const nativeRect = openButton.getBoundingClientRect.bind(openButton);
          let shifted = false;
          openButton.getBoundingClientRect = () => {
            const rect = nativeRect();
            if (!shifted) {
              shifted = true;
              queueMicrotask(() => window.scrollBy({ top: 64, behavior: 'instant' }));
            }
            return rect;
          };
          document.addEventListener('click', event => {
            document.querySelector('#result').textContent = event.isTrusted ? event.target.id : 'untrusted';
          });
        </script>`;
      const page = await browser.page('data:text/html,' + encodeURIComponent(html));
      await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete" && !!document.querySelector("#open")'), 'late scroll fixture ready');
      await click(browser, page, '#open');
      assert.equal(await evaluate(browser, page.session, 'document.querySelector("#result").textContent'), 'open');
    });
  } finally { await browser.cleanup(); }
});
