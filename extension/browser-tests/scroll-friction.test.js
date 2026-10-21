'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const [site, url, messagesURL, editor] of [
  ['x', 'https://x.com/home', '/messages', '<div data-testid="tweetComposer"><div id="editor" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Synthetic draft</div></div>'],
  ['linkedin', 'https://www.linkedin.com/feed/', '/messaging/', '<div class="comments-comment-box"><div id="editor" contenteditable="true" role="textbox">Synthetic draft</div></div>']
]) {
  test(`built slow-scrolling preference changes trusted ${site} wheel input without affecting writing or nested panels`, async () => {
    const { launch, evaluate, eventually, click, withFailureArtifacts } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, `${site} slow-scrolling journey`, async () => {
        await evaluate(browser, browser.worker, `(async () => {
          await chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS }, _access: { ${site}: { remainingMs: 300000, date: C3.localDate() } } });
        })()`);
        const settings = await browser.page(browser.origin + '/settings.html');
        await eventually(() => evaluate(browser, settings.session, '!document.querySelector("#scroll-friction-enabled")?.disabled'), 'Settings loaded');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked'), false);
        const contexts = new Map();
        browser.cdp.on('Runtime.executionContextCreated', ({ context }, session) => {
          if (context.origin === browser.origin) contexts.set(session, context.id);
        });
        const page = await browser.page(url);
        await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'synthetic feed loaded');
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify('<style>body{margin:0;min-height:20000px}#editor{min-height:100px}#panel{position:fixed;right:20px;top:150px;width:200px;height:150px;overflow:auto;background:white}</style><h1>Synthetic feed</h1>' + editor + '<div id="panel"><div style="height:2000px">Nested panel</div></div>')}`);
        async function listenerEnabled() {
          if (!contexts.has(page.session)) return false;
          const { result } = await browser.cdp.send('Runtime.evaluate', { expression: 'document', contextId: contexts.get(page.session) }, page.session);
          try {
            const { listeners } = await browser.cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }, page.session);
            return listeners.some(listener => listener.type === 'wheel' && !listener.passive);
          } finally { await browser.cdp.send('Runtime.releaseObject', { objectId: result.objectId }, page.session); }
        }
        async function wheel(delta, extra = {}) {
          await evaluate(browser, page.session, 'document.scrollingElement.scrollTop = 1000');
          await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: delta, ...extra }, page.session);
          await eventually(() => evaluate(browser, page.session, 'document.scrollingElement.scrollTop !== 1000'), 'wheel moves the document');
          return evaluate(browser, page.session, `(async () => {
            let previous = -1, stable = 0;
            for (let frame = 0; frame < 120 && stable < 5; frame++) {
              await new Promise(requestAnimationFrame);
              const next = document.scrollingElement.scrollTop;
              stable = next === previous ? stable + 1 : 0; previous = next;
            }
            return document.scrollingElement.scrollTop - 1000;
          })()`);
        }
        assert.equal(await wheel(240), 240, 'default wheel scrolling is native');
        await click(browser, settings, '#scroll-friction-enabled');
        await eventually(() => evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked && !document.querySelector("#scroll-friction-enabled").disabled'), 'slow scrolling saved');
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(listenerEnabled, 'foreground tracker attaches slow scrolling');
        assert.equal(await wheel(240), 120);
        assert.equal(await wheel(-240), -120);
        await evaluate(browser, page.session, 'document.querySelector("#panel").scrollTop = 0');
        const point = await evaluate(browser, page.session, '(() => { const r = document.querySelector("#panel").getBoundingClientRect(); return { x: r.x + 30, y: r.y + 30 }; })()');
        const position = await evaluate(browser, page.session, 'scrollY');
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 240 }, page.session);
        await eventually(() => evaluate(browser, page.session, 'document.querySelector("#panel").scrollTop === 240'), 'nested panel retains native distance');
        assert.equal(await evaluate(browser, page.session, 'scrollY'), position);
        await click(browser, page, '#editor');
        await eventually(async () => !await listenerEnabled(), 'writing releases slow scrolling');
        assert.equal(await wheel(240), 240, 'writing does not slow page scrolling');
        await browser.cdp.send('Input.insertText', { text: ' Still writing.' }, page.session);
        assert.match(await evaluate(browser, page.session, 'document.querySelector("#editor").textContent'), /Still writing/);
        await evaluate(browser, page.session, `document.activeElement.blur(); history.pushState({}, '', ${JSON.stringify(messagesURL)});`);
        await eventually(async () => !await listenerEnabled(), 'messaging has no friction');
        assert.equal(await wheel(240), 240);
        await evaluate(browser, page.session, `history.pushState({}, '', ${JSON.stringify(new URL(url).pathname)})`);
        await eventually(listenerEnabled, 'returning to the feed restores slow scrolling');
        await click(browser, settings, '#scroll-friction-enabled');
        await eventually(() => evaluate(browser, settings.session, '!document.querySelector("#scroll-friction-enabled").checked && !document.querySelector("#scroll-friction-enabled").disabled'), 'native scrolling saved');
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(async () => !await listenerEnabled(), 'disabling removes the slow listener');
        assert.equal(await wheel(240), 240);
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}
