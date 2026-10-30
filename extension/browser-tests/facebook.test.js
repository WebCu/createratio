'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('built Facebook preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "facebook", "name": "Facebook", "gated": false, "url": "https://www.facebook.com/", "neutral": "/settings", "markup": "<form id=\"composer\"><div role=\"textbox\" contenteditable=\"true\" aria-label=\"Write a comment...\"></div><button id=\"submit-comment\" type=\"button\" aria-label=\"Comment\">Comment</button></form>", "editor": "form [role=\"textbox\"][contenteditable=\"true\"][aria-label=\"Write a comment...\"]"});
});

test('built Facebook keeps equivalent own-profile URLs on native scrolling', async () => {
  const { launch, evaluate, eventually, withFailureArtifacts } = await import('./chromium.mjs');
  const { scrollFixture } = await import('./scrolling.mjs');
  const browser = await launch(path.resolve(__dirname, '../../dist/chrome'));
  try {
    await withFailureArtifacts(browser, 'Facebook mixed-form own profiles', async () => {
      await evaluate(browser, browser.worker, 'chrome.storage.local.set({ settings: { ...C3.DEFAULT_SETTINGS, trackedSites: ["facebook"] } })');
      const scrolling = scrollFixture(browser);
      for (const [route, ownRoute] of [['/people/Synthetic/123/', '/profile.php?id=123'], ['/profile.php?id=123', '/people/Synthetic/123/']]) {
        const page = await browser.page('https://www.facebook.com' + route);
        await eventually(() => scrolling.isEnabled(page), 'an unidentified profile starts as consuming');
        const markup = '<style>html{scroll-behavior:auto}body{margin:0;min-height:20000px}</style><h1>Synthetic profile</h1><a id="own-profile" aria-label="Your profile" href="https://facebook.com' + ownRoute + '">Your profile</a>';
        await evaluate(browser, page.session, `document.body.innerHTML = ${JSON.stringify(markup)}`);
        await eventually(async () => !await scrolling.isEnabled(page), 'the matching profile ID removes scroll resistance');
        assert.equal(await scrolling.distance(page, 'html', 240), 240, 'own profiles scroll natively');
        assert.equal(await scrolling.distance(page, 'html', -240), -240);
        await evaluate(browser, page.session, 'document.querySelector("#own-profile").href = "https://facebook.com/profile.php?id=456"');
        await eventually(() => scrolling.isEnabled(page), 'a different profile ID remains consuming');
        assert.equal(await scrolling.distance(page, 'html', 240), 120, 'other profiles retain shared resistance');
      }
      assert.deepEqual(browser.errors, []);
    });
  } finally { await browser.cleanup(); }
});
