'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const route of ['/messaging/thread/synthetic-thread/', '/feed/']) {
  test(`built LinkedIn integration records focused DM writing on ${route} without submission bonuses`, async () => {
    const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, 'LinkedIn direct-message creation time', async () => {
        await evaluate(browser, browser.worker, `(async () => {
          await chrome.storage.local.set({
            settings: { ...C3.DEFAULT_SETTINGS, allowAboveGoal: false },
            _access: { linkedin: { remainingMs: 300000, expiresAt: 0, date: C3.localDate() } }
          });
          globalThis.linkedinSnapshots = 0;
          chrome.runtime.onMessage.addListener((message, sender) => {
            if (sender.url?.startsWith('https://www.linkedin.com/') && message.type === 'snapshot') linkedinSnapshots++;
          });
        })()`);
        await browser.page(browser.origin + '/popup.html');
        await eventually(() => evaluate(browser, browser.worker, 'chrome.declarativeNetRequest.getSessionRules().then(rules => rules.some(rule => rule.id === 102))'), 'LinkedIn access rules allow the synthetic page');
        const totals = () => evaluate(browser, browser.worker, 'chrome.storage.local.get(C3.localDate()).then(data => data[C3.localDate()]?.linkedin || {})');
        const page = await browser.page('https://www.linkedin.com' + route);
        await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete" && !!document.querySelector("#synthetic-site") && document.hasFocus() && !document.hidden'), 'synthetic LinkedIn page is focused');
        await eventually(() => evaluate(browser, browser.worker, 'linkedinSnapshots > 0'), 'LinkedIn creation tracker has access preferences');
        await evaluate(browser, page.session, `document.body.innerHTML = '<form class="msg-form"><div id="message" class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message" style="min-height:80px;border:1px solid"></div><button id="send" type="button" class="msg-form__send-button">Send</button></form>'`);
        await click(browser, page, '#message');
        await browser.cdp.send('Input.insertText', { text: 'Synthetic connection message; never sent.' }, page.session);
        await eventually(() => evaluate(browser, page.session, 'document.activeElement.id === "message" && document.querySelector("#message").textContent.includes("Synthetic connection")'), 'trusted input reaches the focused DM editor');
        await eventually(async () => (await totals()).createSec > 0, `DM writing saves creation time on ${route}`);
        await click(browser, page, '#send');
        const activity = await totals();
        for (const action of ['posts', 'comments', 'replies']) assert.equal(activity[action] || 0, 0, 'DMs do not earn submission bonuses');
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}
