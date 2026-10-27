'use strict';
const { test } = require('node:test');

test('built Facebook preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "facebook", "name": "Facebook", "gated": false, "url": "https://www.facebook.com/", "neutral": "/settings", "markup": "<form id=\"composer\"><div role=\"textbox\" contenteditable=\"true\" aria-label=\"Write a comment...\"></div><button id=\"submit-comment\" type=\"button\" aria-label=\"Comment\">Comment</button></form>", "editor": "form [role=\"textbox\"][contenteditable=\"true\"][aria-label=\"Write a comment...\"]"});
});
