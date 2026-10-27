'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('built Instagram preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "instagram", "name": "Instagram", "url": "https://www.instagram.com/p/synthetic/", "neutral": "/accounts/edit/", "markup": "<form id=\"composer\"><textarea aria-label=\"Add a comment…\"></textarea><button id=\"submit-comment\" type=\"button\">Post</button></form>", "editor": "form textarea[aria-label=\"Add a comment…\"]"});
});

test('built Instagram counts a rich-text Reel caption Share once in saved history', async () => {
  const { launch, evaluate, eventually, clickByRole, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'Instagram rich-text Reel caption', async () => {
      await seedAccess(browser, ['instagram'], { trackedSites: ['instagram'] });
      await evaluate(browser, browser.worker, `globalThis.reelSnapshots = 0;
        chrome.runtime.onMessage.addListener((message, sender) => {
          if (message.type === 'snapshot' && sender.url?.startsWith('https://www.instagram.com/')) reelSnapshots++;
        });`);
      const page = await browser.page('https://www.instagram.com/');
      await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.readyState === "complete" && document.hasFocus()'), 'offline Instagram fixture ready');
      await eventually(() => evaluate(browser, browser.worker, 'reelSnapshots > 0'), 'Instagram tracker reads enabled access');
      await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(`
        <style>[role="dialog"]{padding:24px}[role="textbox"]{border:1px solid;min-height:100px;margin:20px 0}[role="button"]{display:inline-block;padding:12px;border:1px solid;margin:12px}</style>
        <div role="dialog" aria-label="New reel">
          <h1>New reel</h1>
          <div role="textbox" contenteditable="true" aria-label="Write a caption..."></div>
          <button>Next</button>
          <div role="button" tabindex="0"><span>Share</span></div>
        </div>`)};`);
      const totals = () => evaluate(browser, browser.worker, 'chrome.storage.local.get(C3.localDate()).then(data => data[C3.localDate()]?.instagram || {})');
      await clickByRole(browser, page, 'textbox', 'Write a caption...');
      await browser.cdp.send('Input.insertText', { text: 'Synthetic Reel caption; never published.' }, page.session);
      assert.equal((await totals()).posts || 0, 0, 'writing a caption is not a submission');
      await clickByRole(browser, page, 'button', 'Next');
      assert.equal((await totals()).posts || 0, 0, 'an upload step is not a submission');
      await clickByRole(browser, page, 'button', 'Share');
      await clickByRole(browser, page, 'button', 'Share');
      await eventually(async () => (await totals()).posts === 1, 'final Reel Share saves exactly one post');
      const dashboard = await browser.page(browser.origin + '/dashboard.html');
      await eventually(() => evaluate(browser, dashboard.session, 'document.readyState === "complete"'), 'dashboard ready');
      assert.equal((await totals()).posts, 1, 'saved Reel action survives leaving Instagram');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
