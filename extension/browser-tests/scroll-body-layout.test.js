'use strict';
const { test } = require('node:test');

for (const entry of [
  ['independent body', 'overflow:hidden', '', 'body'],
  ['one clipped root axis', 'overflow-x:clip;overflow-y:visible', '', 'body'],
  ['viewport-propagated body', 'overflow:visible', '', 'html'],
  ['root containment', 'overflow:visible;contain:layout', '', 'body'],
  ['body containment', 'overflow:visible', 'contain:layout', 'body'],
  ['body content visibility', 'overflow:visible', 'content-visibility:auto', 'body'],
  ['body size container after delayed access rules', 'overflow:visible', 'container-type:inline-size', 'body', 1000]
]) {
  test(`built body scrolling distinguishes the viewport and preserves tall panels: ${entry[0]}`, async () => {
    const { bodyScrollJourney } = await import('./scrolling.mjs');
    await bodyScrollJourney(...entry);
  });
}
