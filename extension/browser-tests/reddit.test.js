'use strict';
const { test } = require('node:test');

test('built Reddit shares opt-in timed access, scrolling, focused writing and retained history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "reddit", "name": "Reddit", "gated": true, "url": "https://www.reddit.com/r/synthetic/comments/abc123/synthetic/", "neutral": "/settings", "markup": "<form id=\"composer\" action=\"/api/comment\"><textarea name=\"text\" readonly aria-label=\"Read-only draft\"></textarea><shreddit-composer><textarea name=\"text\" aria-label=\"Nested comment\"></textarea></shreddit-composer><textarea id=\"comment-editor\" name=\"text\" aria-label=\"Comment\"></textarea><button id=\"submit-comment\" type=\"button\">Comment</button></form>", "editor": "#comment-editor"});
});
