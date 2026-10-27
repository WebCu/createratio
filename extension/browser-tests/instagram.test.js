'use strict';
const { test } = require('node:test');

test('built Instagram preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "instagram", "name": "Instagram", "url": "https://www.instagram.com/p/synthetic/", "neutral": "/accounts/edit/", "markup": "<form id=\"composer\"><textarea aria-label=\"Add a comment…\"></textarea><button id=\"submit-comment\" type=\"button\">Post</button></form>", "editor": "form textarea[aria-label=\"Add a comment…\"]"});
});
