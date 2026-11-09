'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

test('built LinkedIn post editor recognition requires the composer route and a visible editable post field', async () => {
  const { launch, evaluate, eventually, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const bundle = path.resolve(__dirname, '../../dist/chrome');
  const browser = await launch(bundle);
  try {
    await withFailureArtifacts(browser, 'LinkedIn post editor recognition', async () => {
      await seedAccess(browser, ['linkedin'], { allowAboveGoal: false });
      const page = await browser.page('https://www.linkedin.com/sharing/compose');
      await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete" && !!document.querySelector("#synthetic-site")'), 'synthetic composer is ready');
      const source = ['sites.js', 'dom.js'].map(file => readFileSync(path.join(bundle, file), 'utf8')).join('\n');
      await evaluate(browser, page.session, source);
      const cases = [
        { name: 'unlabelled modern post', route: '/sharing/compose', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', expected: 'create' },
        { name: 'trailing slash and query', route: '/sharing/compose/?synthetic=true', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', expected: 'create' },
        { name: 'nested editor focus', route: '/sharing/compose', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', nested: true, expected: 'create' },
        { name: 'plain unrelated textbox', route: '/sharing/compose', attributes: 'role="textbox" contenteditable="true"', expected: 'neutral' },
        { name: 'unrelated rich-text engine', route: '/sharing/compose', attributes: 'class="ProseMirror" role="textbox" contenteditable="true"', expected: 'neutral' },
        { name: 'read-only post', route: '/sharing/compose', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="false"', expected: 'neutral' },
        { name: 'hidden post', route: '/sharing/compose', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true" style="visibility:hidden"', expected: 'neutral' },
        { name: 'non-textbox rich field', route: '/sharing/compose', attributes: 'class="tiptap ProseMirror" role="searchbox" contenteditable="true"', expected: 'neutral' },
        { name: 'unrelated editor on jobs page', route: '/jobs/', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', expected: 'neutral' },
        { name: 'unrelated editor on feed', route: '/feed/', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', expected: 'consume' },
        { name: 'similar route is not a post composer', route: '/sharing/compose-unrelated', attributes: 'class="tiptap ProseMirror" role="textbox" contenteditable="true"', expected: 'neutral' }
      ];
      for (const entry of cases) {
        const result = await evaluate(browser, page.session, `(() => {
          const entry = ${JSON.stringify(entry)};
          history.replaceState({}, '', entry.route);
          document.body.innerHTML = '<div id="editor" tabindex="0" ' + entry.attributes + '><span id="nested" tabindex="0">Synthetic draft</span></div><button id="outside">Outside editor</button>';
          document.querySelector(entry.nested ? '#nested' : '#editor').focus();
          const adapter = C3Sites.get('linkedin').create({ document, location, dom: C3_DOM({ document, location, Element, getComputedStyle }) });
          const focused = adapter.mode();
          document.querySelector('#outside').focus();
          return { focused, outside: adapter.mode() };
        })()`);
        assert.equal(result.focused, entry.expected, entry.name);
        assert.equal(result.outside, entry.route === '/feed/' ? 'consume' : 'neutral', entry.name + ' stops creating when the editor loses focus');
      }
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});

test('built LinkedIn post composer records trusted writing as creating time', async () => {
  const { launch, evaluate, eventually, click, seedAccess, withFailureArtifacts } = await import('./chromium.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'LinkedIn post composer creation time', async () => {
      await seedAccess(browser, ['linkedin'], { allowAboveGoal: false });
      await evaluate(browser, browser.worker, `chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.url?.startsWith('https://www.linkedin.com/') && message.type === 'snapshot') globalThis.postTrackerReady = true;
      })`);
      const page = await browser.page('https://www.linkedin.com/sharing/compose');
      await eventually(() => evaluate(browser, page.session, 'document.readyState === "complete" && !!document.querySelector("#synthetic-site") && document.hasFocus() && !document.hidden'), 'synthetic LinkedIn composer is focused');
      await eventually(() => evaluate(browser, browser.worker, 'globalThis.postTrackerReady === true'), 'post tracker has access preferences');
      await evaluate(browser, page.session, `document.body.innerHTML = '<div><div id="post-editor" class="tiptap ProseMirror" role="textbox" contenteditable="true" style="min-height:80px;border:1px solid"></div></div>'`);
      await click(browser, page, '#post-editor');
      await browser.cdp.send('Input.insertText', { text: 'Synthetic post draft; never submitted.' }, page.session);
      await eventually(() => evaluate(browser, page.session, 'document.activeElement.id === "post-editor" && document.querySelector("#post-editor").textContent === "Synthetic post draft; never submitted."'), 'trusted typing reaches the modern post editor');
      await eventually(() => evaluate(browser, browser.worker, 'chrome.storage.local.get(C3.localDate()).then(data => data[C3.localDate()]?.linkedin?.createSec > 0)'), 'post writing reaches saved creating time');
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});

for (const [route, shadow] of [['/messaging/thread/synthetic-thread/', false], ['/feed/', false], ['/feed/', true], ['/in/synthetic-profile/', true]]) {
  test(`built LinkedIn integration records focused ${shadow ? 'shadow ' : ''}DM writing on ${route} without submission bonuses`, async () => {
    const { launch, evaluate, eventually, click, clickByRole, withFailureArtifacts } = await import('./chromium.mjs');
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
        await evaluate(browser, page.session, `(() => {
          document.body.innerHTML = '<div id="overlay"></div><button id="close" type="button">Close conversation</button>';
          const host = document.querySelector('#overlay');
          const root = ${shadow} ? host.attachShadow({ mode: 'open' }) : host;
          root.innerHTML = '<form class="msg-form"><div id="message" class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message" style="min-height:80px;border:1px solid"></div><button id="send" type="button" class="msg-form__send-button">Send</button></form>';
          document.querySelector('#close').addEventListener('click', () => host.remove());
        })()`);
        const root = shadow ? 'document.querySelector("#overlay").shadowRoot' : 'document';
        await clickByRole(browser, page, 'textbox', 'Write a message');
        await browser.cdp.send('Input.insertText', { text: 'Synthetic connection message; never sent.' }, page.session);
        await eventually(() => evaluate(browser, page.session, `${root}.activeElement?.id === 'message' && ${root}.querySelector('#message').textContent.includes('Synthetic connection')`), 'trusted input reaches the focused DM editor');
        await eventually(async () => (await totals()).createSec > 0, `DM writing saves creation time on ${route}`);
        const writing = await totals();
        await clickByRole(browser, page, 'button', 'Send');
        if (shadow) {
          await eventually(async () => (await totals()).consumeSec > (writing.consumeSec || 0), 'reading inside the shadow overlay returns to consumption');
          const reading = await totals();
          await new Promise(resolve => setTimeout(resolve, 5500));
          assert.equal((await totals()).createSec, reading.createSec, 'reading does not keep accumulating creation');
          await clickByRole(browser, page, 'textbox', 'Write a message');
          await browser.cdp.send('Input.insertText', { text: ' More synthetic writing.' }, page.session);
          await eventually(async () => (await totals()).createSec > reading.createSec, 'returning to shadow writing resumes creation');
          await click(browser, page, '#close');
          await eventually(() => evaluate(browser, page.session, '!document.querySelector("#overlay")'), 'closing removes the shadow overlay');
          await new Promise(resolve => setTimeout(resolve, 5500));
          const closed = await totals();
          await new Promise(resolve => setTimeout(resolve, 5500));
          assert.equal((await totals()).createSec, closed.createSec, 'closing stops creation');
        }
        const activity = await totals();
        for (const action of ['posts', 'comments', 'replies']) assert.equal(activity[action] || 0, 0, 'DMs do not earn submission bonuses');
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}
