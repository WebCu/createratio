'use strict';
const { test } = require('node:test');

test('built TikTok preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "tiktok", "name": "TikTok", "url": "https://www.tiktok.com/@synthetic/video/1234567890", "neutral": "/messages", "markup": "<div id=\"composer\" class=\"DivCommentInputContainer\"><div data-e2e=\"comment-input\"><div contenteditable=\"true\" role=\"textbox\" aria-label=\"Comment\"></div></div><button id=\"submit-comment\" type=\"button\" data-e2e=\"comment-post\">Post</button></div>", "editor": "[data-e2e=\"comment-input\"] [contenteditable=\"true\"]"});
});
