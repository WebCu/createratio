'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
