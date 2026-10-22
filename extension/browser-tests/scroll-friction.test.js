'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const [site, url, messagesURL, editor] of [
  ['x', 'https://x.com/home', '/messages', '<div data-testid="tweetComposer"><div id="editor" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Synthetic draft</div></div>'],
  ['linkedin', 'https://www.linkedin.com/feed/', '/messaging/', '<div class="comments-comment-box"><div id="editor" contenteditable="true" role="textbox">Synthetic draft</div></div>']
]) {
  test(`built slow-scrolling preference changes trusted ${site} wheel input without affecting writing or nested panels`, async () => {
    const { launch, evaluate, eventually, click, withFailureArtifacts, seedAccess, waitForEnabledControl } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, `${site} slow-scrolling journey`, async () => {
        await seedAccess(browser, [site], site === 'x' ? undefined : { accessMinutes: 12 });
        await evaluate(browser, browser.worker, `(() => {
          globalThis.resistanceSaves = 0;
          chrome.runtime.onMessage.addListener(message => { if (message.type === 'scroll-friction-setting') resistanceSaves++; });
        })()`);
        const settings = await browser.page('about:blank');
        await assert.rejects(waitForEnabledControl(browser, settings, '#scroll-friction-enabled', 100), /Timed out: enabled control/);
        await browser.cdp.send('Page.navigate', { url: browser.origin + '/settings.html' }, settings.session);
        await waitForEnabledControl(browser, settings, '#scroll-friction-enabled');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked'), true);
        const { scrollFixture } = await import('./scrolling.mjs');
        const scroll = scrollFixture(browser);
        const page = await browser.page(url);
        await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'synthetic feed loaded');
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify('<style>body{margin:0;min-height:20000px}#editor{min-height:100px}#panel{position:fixed;right:20px;top:150px;width:200px;height:150px;overflow:auto;background:white}</style><h1>Synthetic feed</h1>' + editor + '<div id="panel"><div style="height:2000px">Nested panel</div></div>')}`);
        const listenerEnabled = () => scroll.isEnabled(page);
        const wheel = delta => scroll.distance(page, 'html', delta);
        await eventually(listenerEnabled, 'default friction attaches without a saved choice');
        assert.equal(await wheel(240), 120, 'default wheel scrolling moves half as far');
        assert.equal(await evaluate(browser, browser.worker, 'resistanceSaves'), 0);
        await click(browser, settings, '#scroll-friction-enabled');
        await eventually(() => evaluate(browser, settings.session, 'document.querySelector("#save-status").textContent.includes("disabled")'), 'explicit Off saved');
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(async () => !await listenerEnabled(), 'explicit Off releases friction');
        assert.equal(await wheel(240), 240, 'explicit Off restores native scrolling');
        await click(browser, settings, '#scroll-friction-enabled');
        await eventually(() => evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked && document.querySelector("#save-status").textContent.includes("saved at 50%")'), 'slow scrolling saved');
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(listenerEnabled, 'foreground tracker attaches slow scrolling');
        assert.equal(await wheel(240), 120);
        assert.equal(await wheel(-240), -120);
        async function strengthSaved(strength) {
          await eventually(() => evaluate(browser, settings.session, `document.querySelector('#scroll-friction-strength').value === '${strength}' && document.querySelector('#save-status').textContent.includes('saved at ${strength}%')`), 'resistance acknowledged and trackers notified');
          assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data => data.settings.scrollFrictionStrength)'), strength);
          assert.equal(await evaluate(browser, settings.session, 'document.activeElement.id'), 'scroll-friction-strength');
          await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
          await eventually(listenerEnabled, 'every enabled strength keeps the friction listener');
          await evaluate(browser, page.session, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        await click(browser, settings, 'label[for="scroll-friction-strength"]');
        const range = await evaluate(browser, settings.session, '(() => { const input = document.querySelector("#scroll-friction-strength"); return { ...input.getBoundingClientRect().toJSON(), min: Number(input.min), max: Number(input.max) }; })()');
        assert.equal(range.min, 50); assert.equal(range.max, 95);
        const sliderX = strength => range.x + 12 + (range.width - 24) * (strength - range.min) / (range.max - range.min);
        const start = { x: sliderX(50), y: range.y + range.height / 2 };
        const saves = await evaluate(browser, browser.worker, 'resistanceSaves');
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start }, settings.session);
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...start }, settings.session);
        for (const strength of [55, 60, 65, 70, 75, 80]) {
          await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: sliderX(strength), y: start.y }, settings.session);
        }
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-value").textContent'), '80%');
        assert.equal(await evaluate(browser, browser.worker, 'resistanceSaves'), saves, 'drag previews do not write preferences');
        await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: sliderX(80), y: start.y }, settings.session);
        await strengthSaved(80);
        assert.equal(await evaluate(browser, browser.worker, 'resistanceSaves'), saves + 1);
        assert.equal(await wheel(240), 48);
        for (const [keys, strength, distance] of [
          [['End'], 95, 12], [Array(4).fill('ArrowLeft'), 75, 60], [['Home', 'ArrowLeft'], 50, 120]
        ]) {
          await click(browser, settings, 'label[for="scroll-friction-strength"]');
          for (const key of keys) {
            const code = { End: 35, Home: 36, ArrowLeft: 37, ArrowRight: 39 }[key];
            await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code }, settings.session);
            await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }, settings.session);
          }
          await strengthSaved(strength);
          assert.equal(await wheel(240), distance);
        }
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
        await eventually(() => evaluate(browser, settings.session, '!document.querySelector("#scroll-friction-enabled").checked && document.querySelector("#save-status").textContent.includes("disabled")'), 'native scrolling saved');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").value'), '50');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").disabled'), true);
        await browser.cdp.send('Page.reload', {}, settings.session);
        await waitForEnabledControl(browser, settings, '#scroll-friction-enabled');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked'), false);
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").value'), '50');
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(async () => !await listenerEnabled(), 'disabling removes the slow listener');
        assert.equal(await wheel(240), 240);
        await evaluate(browser, browser.worker, `(async () => {
          const { settings } = await chrome.storage.local.get('settings');
          await chrome.storage.local.set({ settings: { ...settings, scrollFrictionEnabled: true, scrollFrictionStrength: 0 } });
        })()`);
        await browser.cdp.send('Page.reload', {}, settings.session);
        await waitForEnabledControl(browser, settings, '#scroll-friction-enabled');
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-enabled").checked'), false);
        assert.equal(await evaluate(browser, settings.session, 'document.querySelector("#scroll-friction-strength").value'), '50');
        assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data => data.settings.scrollFrictionStrength)'), 0);
        await click(browser, settings, '#scroll-friction-enabled');
        await eventually(() => evaluate(browser, settings.session, 'document.querySelector("#save-status").textContent.includes("saved at 50%")'), 'enabling replaces saved zero with a positive strength');
        assert.equal(await evaluate(browser, browser.worker, 'chrome.storage.local.get("settings").then(data => data.settings.scrollFrictionStrength)'), 50);
        await browser.cdp.send('Target.activateTarget', { targetId: page.targetId });
        await eventually(listenerEnabled, 're-enabled stored-zero preference adds friction');
        assert.equal(await wheel(240), 120);
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}

for (const [label, lock, overflow, panelHeight] of [
  ['no document scroll range', null, null, 120],
  ['tall nested panel', null, null, 500],
  ['hidden root with a scroll range', 'html', 'hidden', 120],
  ['clipped root with a scroll range', 'html', 'clip', 120],
  ['hidden body with a scroll range', 'body', 'hidden', 120],
  ['clipped body with a scroll range', 'body', 'clip', 120]
]) {
  test(`built app-shell slow scrolling preserves native panels: ${label}`, async () => {
    const { launch, evaluate, eventually, withFailureArtifacts, seedAccess } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, `app-shell scrolling: ${label}`, async () => {
        const { scrollFixture } = await import('./scrolling.mjs');
        const scroll = scrollFixture(browser);
        await seedAccess(browser, ['linkedin'], { accessMinutes: 12, scrollFrictionEnabled: false });
        const page = await browser.page('https://www.linkedin.com/feed/');
        await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'synthetic feed loaded');
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page.session);
        const rootStyle = lock ? `html,body{overflow:visible}body{min-height:20000px}${lock}{overflow:${overflow}}` : '';
        const fixture = `<style>html,body{margin:0;height:100%;overflow:hidden}${rootStyle}#workspace{position:fixed;inset:0;overflow:auto}#panel{height:${panelHeight}px;width:200px;margin:20px;overflow:auto;border:1px solid #ccc}</style><main id="workspace"><h1>Synthetic app shell</h1><div id="panel"><div style="height:4000px">Nested panel</div></div><div style="height:20000px">Feed</div></main>`;
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(fixture)}`);
        assert.equal(await evaluate(browser, page.session, 'document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight'), Boolean(lock));
        if (lock) assert.equal(await evaluate(browser, page.session, `getComputedStyle(document.querySelector('${lock}')).overflowY`), overflow);
        const targets = [
          { selector: '#workspace', distance: 120, stationary: ['html', 'body', '#panel'] },
          { selector: '#panel', point: null, distance: 240, stationary: ['html', 'body', '#workspace'] }
        ];
        await scroll.assertNative(page, targets);
        await scroll.setEnabled(page, true);
        await scroll.verify(page, targets);
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}

for (const [label, htmlStyle, bodyStyle, surface, rulesDelayMs = 0] of [
  ['independent body', 'overflow:hidden', '', 'body'],
  ['one clipped root axis', 'overflow-x:clip;overflow-y:visible', '', 'body'],
  ['viewport-propagated body', 'overflow:visible', '', 'html'],
  ['root containment', 'overflow:visible;contain:layout', '', 'body'],
  ['body containment', 'overflow:visible', 'contain:layout', 'body'],
  ['body content visibility', 'overflow:visible', 'content-visibility:auto', 'body'],
  ['body size container after delayed access rules', 'overflow:visible', 'container-type:inline-size', 'body', 1000],
  ['scroll-state without size containment', 'overflow:visible', 'container-type:scroll-state', 'html'],
  ['non-propagated hidden body', 'overflow:auto', 'height:auto;overflow:hidden', 'html'],
  ['non-propagated clipped body', 'overflow:auto', 'height:auto;overflow:clip', 'html'],
  ['root containment with hidden body', 'overflow:visible;contain:layout;height:auto', 'height:auto;overflow:hidden', 'html'],
  ['root containment with clipped body', 'overflow:visible;contain:layout;height:auto', 'height:auto;overflow:clip', 'html'],
  ['body containment with hidden overflow', 'overflow:visible', 'height:auto;overflow:hidden;contain:layout', 'html'],
  ['body containment with clipped overflow', 'overflow:visible', 'height:auto;overflow:clip;contain:layout', 'html']
]) {
  test(`built body scrolling distinguishes the viewport and preserves tall panels: ${label}`, async () => {
    const { launch, evaluate, eventually, withFailureArtifacts, seedAccess } = await import('./chromium.mjs');
    const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
    try {
      await withFailureArtifacts(browser, `body scrolling: ${label}`, async () => {
        const { scrollFixture } = await import('./scrolling.mjs');
        const scroll = scrollFixture(browser);
        if (rulesDelayMs) await evaluate(browser, browser.worker, `(() => {
          const update = chrome.declarativeNetRequest.updateSessionRules.bind(chrome.declarativeNetRequest);
          chrome.declarativeNetRequest.updateSessionRules = async options => {
            await new Promise(resolve => setTimeout(resolve, ${rulesDelayMs}));
            return update(options);
          };
        })()`);
        await seedAccess(browser, ['linkedin'], { scrollFrictionEnabled: false });
        const page = await browser.page('https://www.linkedin.com/feed/');
        await eventually(() => evaluate(browser, page.session, '!!document.querySelector("#synthetic-site") && document.hasFocus()'), 'synthetic feed loaded');
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page.session);
        const fixture = `<style>html,body{height:100%;margin:0}html{${htmlStyle}}body{overflow:auto;${bodyStyle}}#panel{height:500px;width:200px;overflow:auto}</style><div id="panel"><div style="height:4000px">Synthetic panel</div></div><div style="height:20000px">Synthetic feed</div>`;
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(fixture)}`);
        const targets = [
          { selector: surface, distance: 120, stationary: [surface === 'body' ? 'html' : 'body', '#panel'] },
          { selector: '#panel', point: { x: 100, y: 100 }, distance: 240, stationary: ['html', 'body'] }
        ];
        await scroll.assertNative(page, targets);
        await scroll.setEnabled(page, true);
        await scroll.verify(page, targets);
        assert.deepEqual(browser.errors, []);
      });
    } finally { await browser.cleanup(); }
  });
}
