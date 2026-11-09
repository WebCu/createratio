'use strict';
const { test } = require('node:test');

for (const entry of [
  ['scroll-state without size containment', 'overflow:visible', 'container-type:scroll-state', 'html'],
  ['non-propagated hidden body', 'overflow:auto', 'height:auto;overflow:hidden', 'html'],
  ['non-propagated clipped body', 'overflow:auto', 'height:auto;overflow:clip', 'html'],
  ['root containment with hidden body', 'overflow:visible;contain:layout;height:auto', 'height:auto;overflow:hidden', 'html'],
  ['root containment with clipped body', 'overflow:visible;contain:layout;height:auto', 'height:auto;overflow:clip', 'html'],
  ['body containment with hidden overflow', 'overflow:visible', 'height:auto;overflow:hidden;contain:layout', 'html'],
  ['body containment with clipped overflow', 'overflow:visible', 'height:auto;overflow:clip;contain:layout', 'html']
]) {
  test(`built body scrolling distinguishes the viewport and preserves tall panels: ${entry[0]}`, async () => {
    const { bodyScrollJourney } = await import('./scrolling.mjs');
    await bodyScrollJourney(...entry);
  });
}
