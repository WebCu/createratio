'use strict';
const { test } = require('node:test');

test('built YouTube preserves opt-in scrolling, focused writing and submitted history', async () => {
  const { platformJourney } = await import('./platform-tracking.mjs');
  await platformJourney({"id": "youtube", "name": "YouTube", "gated": false, "url": "https://www.youtube.com/watch?v=synthetic", "neutral": "/settings", "markup": "<ytd-commentbox id=\"composer\"><div id=\"contenteditable-root\" contenteditable=\"true\" role=\"textbox\" aria-label=\"Add a comment\"></div><div id=\"submit-button\"><button id=\"submit-comment\" type=\"button\">Comment</button></div></ytd-commentbox>", "editor": "ytd-commentbox #contenteditable-root[contenteditable=\"true\"]"});
});
