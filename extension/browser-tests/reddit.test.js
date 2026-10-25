'use strict';
const { test } = require('node:test');

test('built Reddit preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "reddit", "name": "Reddit", "url": "https://www.reddit.com/r/synthetic/comments/abc123/synthetic/", "neutral": "/settings", "markup": "<form id=\"composer\" action=\"/api/comment\"><textarea name=\"text\" aria-label=\"Comment\"></textarea><button id=\"submit-comment\" type=\"button\">Comment</button></form>", "editor": "form[action=\"/api/comment\"] textarea[name=\"text\"]"});
});
